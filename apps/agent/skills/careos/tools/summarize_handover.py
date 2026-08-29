from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from skills.careos.tools.draft_incident_from_text import (
    contains_prompt_injection,
    fetch_form_template,
    missing_from_errors,
    missing_mandatory,
    post_json,
    validate_form_data,
)


SUMMARIZE_HANDOVER_TOOL: dict[str, Any] = {
    "description": "Summarize shift-end handover notes into handover.shift-end.v1 form_data.",
    "inputSchema": {
        "additionalProperties": False,
        "properties": {
            "correlation_id": {"type": "string"},
            "free_text": {"type": "string"},
            "shift_id": {"type": "string"},
            "transcript_object_key": {"type": ["string", "null"]},
        },
        "required": ["shift_id", "free_text", "correlation_id"],
        "type": "object",
    },
    "name": "summarize_handover",
}


@dataclass(frozen=True)
class SummarizeHandoverInput:
    shift_id: str
    free_text: str
    correlation_id: str
    transcript_object_key: str | None = None

    @classmethod
    def from_arguments(cls, arguments: object) -> "SummarizeHandoverInput":
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be an object.")

        values: dict[str, str] = {}
        for key in ("shift_id", "free_text", "correlation_id"):
            value = arguments.get(key)
            if not isinstance(value, str) or value.strip() == "":
                raise ValueError(f"Missing string argument: {key}.")
            values[key] = value

        transcript = arguments.get("transcript_object_key")
        if transcript is not None and not isinstance(transcript, str):
            raise ValueError("transcript_object_key must be a string or null.")

        return cls(
            correlation_id=values["correlation_id"],
            free_text=values["free_text"],
            shift_id=values["shift_id"],
            transcript_object_key=transcript,
        )


def summarize_handover(
    arguments: object,
    *,
    gateway_headers: dict[str, str] | None = None,
    llm_gateway_url: str,
    mcp_url: str,
    system_prompt_path: Path,
) -> dict[str, Any]:
    tool_input = SummarizeHandoverInput.from_arguments(arguments)
    template = fetch_form_template(mcp_url, "handover.shift-end")
    schema = template["schema"]

    if contains_prompt_injection(tool_input.free_text) or asks_to_mutate(tool_input.free_text):
        form_data: dict[str, Any] = {}
        return {
            "confidence": 0.0,
            "form_data": form_data,
            "missing_mandatory": missing_mandatory(schema, form_data),
            "summary": "",
        }

    model_payload = call_summarize(
        gateway_headers=gateway_headers,
        llm_gateway_url=llm_gateway_url,
        schema=schema,
        system_prompt=system_prompt_path.read_text(encoding="utf-8"),
        tool_input=tool_input,
    )
    form_data = coerce_form_data(model_payload, tool_input)
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
        "summary": coerce_summary(model_payload, form_data),
    }


def call_summarize(
    *,
    gateway_headers: dict[str, str] | None = None,
    llm_gateway_url: str,
    schema: dict[str, Any],
    system_prompt: str,
    tool_input: SummarizeHandoverInput,
) -> dict[str, Any]:
    payload = {
        "messages": [
            {"content": system_prompt, "role": "system"},
            {
                "content": json.dumps(
                    {
                        "free_text": tool_input.free_text,
                        "schema": schema,
                        "shift_id": tool_input.shift_id,
                        "template_id": "handover.shift-end",
                        "transcript_object_key": tool_input.transcript_object_key,
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
        f"{llm_gateway_url.rstrip('/')}/v1/careos/summarize",
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

    raise ValueError("LLM gateway returned an invalid handover summary payload.")


def coerce_form_data(
    model_payload: dict[str, Any], tool_input: SummarizeHandoverInput
) -> dict[str, Any]:
    raw = model_payload.get("form_data")
    form_data = dict(raw) if isinstance(raw, dict) else {}
    form_data["shiftId"] = tool_input.shift_id
    if not isinstance(form_data.get("narrative"), str) or form_data["narrative"].strip() == "":
        form_data["narrative"] = tool_input.free_text
    return form_data


def coerce_summary(model_payload: dict[str, Any], form_data: dict[str, Any]) -> str:
    summary = model_payload.get("summary")
    if isinstance(summary, str) and summary.strip() != "":
        return summary.strip()

    narrative = form_data.get("narrative")
    if isinstance(narrative, str):
        return narrative[:500]
    return ""


def coerce_confidence(value: object) -> float:
    if isinstance(value, int | float):
        return max(0.0, min(1.0, float(value)))
    return 0.0


def asks_to_mutate(free_text: str) -> bool:
    lowered = free_text.lower()
    markers = (
        "send the email",
        "send this email",
        "notify parents now",
        "approve this",
        "publish this",
        "create the task now",
    )
    return any(marker in lowered for marker in markers)
