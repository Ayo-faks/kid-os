from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from jsonschema import ValidationError, validators


DRAFT_INCIDENT_FROM_TEXT_TOOL: dict[str, Any] = {
    "description": "Draft incident form_data from staff free text. Never submits the incident.",
    "inputSchema": {
        "additionalProperties": False,
        "properties": {
            "correlation_id": {"type": "string"},
            "free_text": {"type": "string"},
            "resident_id": {"type": "string"},
            "template_id": {"type": "string"},
        },
        "required": ["template_id", "free_text", "resident_id", "correlation_id"],
        "type": "object",
    },
    "name": "draft_incident_from_text",
}

LIST_FORM_TEMPLATES_TOOL: dict[str, Any] = {
    "description": "List CareOS schema-driven form templates via the NestJS MCP surface.",
    "inputSchema": {"additionalProperties": False, "properties": {}, "type": "object"},
    "name": "list_form_templates",
}

INJECTION_MARKERS = (
    "ignore previous instructions",
    "ignore all previous instructions",
    "disregard previous instructions",
    "bypass the schema",
    "bypass validation",
    "reveal the system prompt",
)


@dataclass(frozen=True)
class DraftIncidentInput:
    template_id: str
    free_text: str
    resident_id: str
    correlation_id: str

    @classmethod
    def from_arguments(cls, arguments: object) -> "DraftIncidentInput":
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be an object.")

        values: dict[str, str] = {}
        for key in ("template_id", "free_text", "resident_id", "correlation_id"):
            value = arguments.get(key)
            if not isinstance(value, str) or value.strip() == "":
                raise ValueError(f"Missing string argument: {key}.")
            values[key] = value

        return cls(
            correlation_id=values["correlation_id"],
            free_text=values["free_text"],
            resident_id=values["resident_id"],
            template_id=values["template_id"],
        )


def list_form_templates(mcp_url: str) -> dict[str, Any]:
    return get_json(f"{mcp_url.rstrip('/')}/tools/list-form-templates")


def draft_incident_from_text(
    arguments: object,
    *,
    gateway_headers: dict[str, str] | None = None,
    llm_gateway_url: str,
    mcp_url: str,
    system_prompt_path: Path,
) -> dict[str, Any]:
    tool_input = DraftIncidentInput.from_arguments(arguments)
    template = fetch_form_template(mcp_url, tool_input.template_id)
    schema = template["schema"]

    if contains_prompt_injection(tool_input.free_text):
        form_data: dict[str, Any] = {}
        return {
            "confidence": 0.0,
            "form_data": form_data,
            "missing_mandatory": missing_mandatory(schema, form_data),
        }

    model_payload = call_extract_structured(
        gateway_headers=gateway_headers,
        llm_gateway_url=llm_gateway_url,
        schema=schema,
        system_prompt=system_prompt_path.read_text(encoding="utf-8"),
        tool_input=tool_input,
    )
    form_data = coerce_form_data(model_payload)
    validation_errors = validate_form_data(schema, form_data)
    missing = sorted(set(missing_mandatory(schema, form_data) + missing_from_errors(validation_errors)))
    confidence = coerce_confidence(model_payload.get("confidence"))

    if validation_errors:
        confidence = min(confidence, 0.49)

    return {"confidence": confidence, "form_data": form_data, "missing_mandatory": missing}


def fetch_form_template(mcp_url: str, template_id: str) -> dict[str, Any]:
    query = urlencode({"template_id": template_id, "version": "v1"})
    payload = get_json(f"{mcp_url.rstrip('/')}/tools/get-form-template?{query}")
    template = payload.get("template")
    if not isinstance(template, dict) or not isinstance(template.get("schema"), dict):
        raise ValueError("MCP get-form-template returned an invalid payload.")
    return template


def call_extract_structured(
    *,
    gateway_headers: dict[str, str] | None = None,
    llm_gateway_url: str,
    schema: dict[str, Any],
    system_prompt: str,
    tool_input: DraftIncidentInput,
) -> dict[str, Any]:
    payload = {
        "messages": [
            {"content": system_prompt, "role": "system"},
            {
                "content": json.dumps(
                    {
                        "free_text": tool_input.free_text,
                        "resident_id": tool_input.resident_id,
                        "schema": schema,
                        "template_id": tool_input.template_id,
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
        f"{llm_gateway_url.rstrip('/')}/v1/careos/extract-structured",
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

    raise ValueError("LLM gateway returned an invalid structured extraction payload.")


def coerce_form_data(model_payload: dict[str, Any]) -> dict[str, Any]:
    form_data = model_payload.get("form_data")
    if isinstance(form_data, dict):
        return dict(form_data)

    camel_form_data = model_payload.get("formData")
    if isinstance(camel_form_data, dict):
        return dict(camel_form_data)

    return {}


def coerce_confidence(value: object) -> float:
    if isinstance(value, int | float):
        return max(0.0, min(1.0, float(value)))
    return 0.0


def validate_form_data(schema: dict[str, Any], form_data: dict[str, Any]) -> list[ValidationError]:
    validator_class = validators.validator_for(schema)
    validator_class.check_schema(schema)
    validator = validator_class(schema)
    return sorted(validator.iter_errors(form_data), key=lambda error: list(error.path))


def missing_mandatory(schema: dict[str, Any], form_data: dict[str, Any], prefix: str = "") -> list[str]:
    missing: list[str] = []
    properties = schema.get("properties")
    if schema.get("type") != "object" or not isinstance(properties, dict):
        return missing

    required = schema.get("required") if isinstance(schema.get("required"), list) else []
    for key, property_schema in properties.items():
        if not isinstance(key, str) or not isinstance(property_schema, dict):
            continue
        path = f"{prefix}.{key}" if prefix else key
        value = form_data.get(key)
        is_mandatory = key in required or property_schema.get("x-mandatory") is True
        if is_mandatory and is_empty(value):
            missing.append(path)
            continue
        if isinstance(value, dict):
            missing.extend(missing_mandatory(property_schema, value, path))

    return missing


def missing_from_errors(errors: list[ValidationError]) -> list[str]:
    missing: list[str] = []
    for error in errors:
        if error.validator != "required":
            continue
        path = ".".join(str(part) for part in error.path)
        missing_property = str(error.message).split("'", 2)[1] if "'" in error.message else ""
        if missing_property:
            missing.append(f"{path}.{missing_property}" if path else missing_property)
    return missing


def is_empty(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, list):
        return len(value) == 0
    return False


def contains_prompt_injection(free_text: str) -> bool:
    lowered = free_text.lower()
    return any(marker in lowered for marker in INJECTION_MARKERS)


def get_json(url: str) -> dict[str, Any]:
    request = Request(url, headers={"accept": "application/json"}, method="GET")
    with urlopen(request, timeout=5) as response:
        decoded = json.loads(response.read().decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError(f"GET {url} returned non-object JSON.")
    return decoded


def post_json(url: str, payload: dict[str, Any], *, headers: dict[str, str]) -> dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"accept": "application/json", **headers},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        decoded = json.loads(response.read().decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError(f"POST {url} returned non-object JSON.")
    return decoded


def mcp_content(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"text": json.dumps(payload, sort_keys=True), "type": "text"}], "isError": False}