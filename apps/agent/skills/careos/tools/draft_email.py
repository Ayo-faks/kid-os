from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from skills.careos.tools.draft_incident_from_text import (
    coerce_confidence,
    contains_prompt_injection,
    fetch_form_template,
    missing_from_errors,
    missing_mandatory,
    post_json,
    validate_form_data,
)


DRAFT_EMAIL_TOOL: dict[str, Any] = {
    "description": (
        "Draft an email as comms.email-draft.v1 form_data with sensitivity classification. "
        "Never sends, never marks as approved, never claims delivery."
    ),
    "inputSchema": {
        "additionalProperties": False,
        "properties": {
            "correlation_id": {"type": "string"},
            "instructions": {"type": "string"},
            "recipient": {
                "additionalProperties": False,
                "properties": {
                    "email": {"type": "string"},
                    "name": {"type": "string"},
                    "role": {"type": "string"},
                },
                "required": ["email"],
                "type": "object",
            },
            "source": {
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string"},
                    "kind": {"enum": ["incident", "handover", "general"], "type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["kind", "summary"],
                "type": "object",
            },
        },
        "required": ["correlation_id", "instructions", "recipient", "source"],
        "type": "object",
    },
    "name": "draft_email",
}

MUTATION_MARKERS = (
    "send now",
    "send the email",
    "send this email",
    "send it now",
    "deliver now",
    "deliver this email",
    "notify parents now",
    "notify immediately",
    "notify the police now",
    "approve this",
    "approve the draft",
    "mark as approved",
    "mark as sent",
    "publish this",
    "publish now",
    "go live",
    "skip review",
    "bypass review",
)

SENSITIVE_KEYWORDS = (
    "safeguarding",
    "police",
    "social worker",
    "medication error",
    "med error",
    "missed medication",
    "self-harm",
    "self harm",
    "abuse",
    "neglect",
    "missing person",
    "absconded",
    "missing from home",
    "parents",
    "guardian",
    "ofsted",
    "serious incident",
    "injury",
    "hospital",
)


@dataclass(frozen=True)
class DraftEmailRecipient:
    email: str
    name: str | None
    role: str | None


@dataclass(frozen=True)
class DraftEmailSource:
    kind: str
    summary: str
    id: str | None


@dataclass(frozen=True)
class DraftEmailInput:
    correlation_id: str
    instructions: str
    recipient: DraftEmailRecipient
    source: DraftEmailSource

    @classmethod
    def from_arguments(cls, arguments: object) -> "DraftEmailInput":
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be an object.")

        correlation_id = arguments.get("correlation_id")
        instructions = arguments.get("instructions")
        if not isinstance(correlation_id, str) or correlation_id.strip() == "":
            raise ValueError("Missing string argument: correlation_id.")
        if not isinstance(instructions, str) or instructions.strip() == "":
            raise ValueError("Missing string argument: instructions.")

        recipient_raw = arguments.get("recipient")
        if not isinstance(recipient_raw, dict):
            raise ValueError("recipient must be an object.")
        email = recipient_raw.get("email")
        if not isinstance(email, str) or email.strip() == "":
            raise ValueError("recipient.email must be a non-empty string.")
        name = recipient_raw.get("name") if isinstance(recipient_raw.get("name"), str) else None
        role = recipient_raw.get("role") if isinstance(recipient_raw.get("role"), str) else None

        source_raw = arguments.get("source")
        if not isinstance(source_raw, dict):
            raise ValueError("source must be an object.")
        kind = source_raw.get("kind")
        summary = source_raw.get("summary")
        if kind not in ("incident", "handover", "general"):
            raise ValueError("source.kind must be one of incident|handover|general.")
        if not isinstance(summary, str) or summary.strip() == "":
            raise ValueError("source.summary must be a non-empty string.")
        source_id = source_raw.get("id") if isinstance(source_raw.get("id"), str) else None

        return cls(
            correlation_id=correlation_id,
            instructions=instructions,
            recipient=DraftEmailRecipient(email=email, name=name, role=role),
            source=DraftEmailSource(kind=kind, summary=summary, id=source_id),
        )


def draft_email(
    arguments: object,
    *,
    gateway_headers: dict[str, str] | None = None,
    llm_gateway_url: str,
    mcp_url: str,
    system_prompt_path: Path,
) -> dict[str, Any]:
    tool_input = DraftEmailInput.from_arguments(arguments)
    template = fetch_form_template(mcp_url, "comms.email-draft")
    schema = template["schema"]

    if (
        contains_prompt_injection(tool_input.instructions)
        or asks_to_mutate(tool_input.instructions)
        or contains_prompt_injection(tool_input.source.summary)
        or asks_to_mutate(tool_input.source.summary)
    ):
        form_data: dict[str, Any] = {}
        return {
            "confidence": 0.0,
            "form_data": form_data,
            "missing_mandatory": missing_mandatory(schema, form_data),
            "refused": True,
        }

    model_payload = call_draft_email(
        gateway_headers=gateway_headers,
        llm_gateway_url=llm_gateway_url,
        schema=schema,
        system_prompt=system_prompt_path.read_text(encoding="utf-8"),
        tool_input=tool_input,
    )
    form_data = coerce_form_data(model_payload, tool_input)
    apply_sensitivity_floor(form_data, tool_input)

    validation_errors = validate_form_data(schema, form_data)
    missing = sorted(
        set(missing_mandatory(schema, form_data) + missing_from_errors(validation_errors))
    )
    confidence = coerce_confidence(model_payload.get("confidence"))
    if validation_errors:
        confidence = min(confidence, 0.49)

    return {
        "confidence": confidence,
        "form_data": form_data,
        "missing_mandatory": missing,
        "refused": False,
    }


def call_draft_email(
    *,
    gateway_headers: dict[str, str] | None = None,
    llm_gateway_url: str,
    schema: dict[str, Any],
    system_prompt: str,
    tool_input: DraftEmailInput,
) -> dict[str, Any]:
    payload = {
        "messages": [
            {"content": system_prompt, "role": "system"},
            {
                "content": json.dumps(
                    {
                        "instructions": tool_input.instructions,
                        "recipient": {
                            "email": tool_input.recipient.email,
                            "name": tool_input.recipient.name,
                            "role": tool_input.recipient.role,
                        },
                        "schema": schema,
                        "source": {
                            "id": tool_input.source.id,
                            "kind": tool_input.source.kind,
                            "summary": tool_input.source.summary,
                        },
                        "template_id": "comms.email-draft",
                    },
                    sort_keys=True,
                ),
                "role": "user",
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }
    headers = {
        "content-type": "application/json",
        "x-careos-correlation-id": tool_input.correlation_id,
        **(gateway_headers or {}),
    }
    response = post_json(
        f"{llm_gateway_url.rstrip('/')}/v1/careos/draft-email",
        payload,
        headers=headers,
    )
    return parse_model_response(response)


def parse_model_response(response: dict[str, Any]) -> dict[str, Any]:
    if "form_data" in response:
        return response

    choices = response.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                decoded = json.loads(message["content"])
                if isinstance(decoded, dict):
                    return decoded

    raise ValueError("LLM gateway returned an invalid email draft payload.")


def coerce_form_data(
    model_payload: dict[str, Any], tool_input: DraftEmailInput
) -> dict[str, Any]:
    raw = model_payload.get("form_data")
    form_data = dict(raw) if isinstance(raw, dict) else {}

    recipient = form_data.get("recipient") if isinstance(form_data.get("recipient"), dict) else {}
    recipient = dict(recipient)
    recipient["email"] = tool_input.recipient.email
    if tool_input.recipient.name is not None:
        recipient.setdefault("name", tool_input.recipient.name)
    if tool_input.recipient.role is not None:
        recipient.setdefault("role", tool_input.recipient.role)
    form_data["recipient"] = recipient

    if form_data.get("sensitivity") not in ("routine", "sensitive"):
        form_data["sensitivity"] = "routine"

    reasons = form_data.get("sensitivity_reasons")
    if not isinstance(reasons, list):
        form_data["sensitivity_reasons"] = []
    else:
        form_data["sensitivity_reasons"] = [r for r in reasons if isinstance(r, str) and r.strip()]

    return form_data


def apply_sensitivity_floor(form_data: dict[str, Any], tool_input: DraftEmailInput) -> None:
    haystack = " ".join(
        [
            tool_input.instructions.lower(),
            tool_input.source.summary.lower(),
            str(form_data.get("subject", "")).lower(),
            str(form_data.get("body", "")).lower(),
        ]
    )
    matched = [keyword for keyword in SENSITIVE_KEYWORDS if keyword in haystack]
    if matched:
        form_data["sensitivity"] = "sensitive"
        existing = form_data.get("sensitivity_reasons")
        existing_list: list[str] = list(existing) if isinstance(existing, list) else []
        for keyword in matched:
            if keyword not in existing_list:
                existing_list.append(keyword)
        form_data["sensitivity_reasons"] = existing_list[:10]


def asks_to_mutate(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in MUTATION_MARKERS)
