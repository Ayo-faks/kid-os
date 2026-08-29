from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from skills.careos.tools.draft_email import asks_to_mutate
from skills.careos.tools.draft_incident_from_text import (
    contains_prompt_injection,
    post_json,
)


NARRATE_ROTA_TOOL: dict[str, Any] = {
    "description": (
        "Describe rota gaps and proposed staff additions in plain English. "
        "Never publishes, approves, sends, or notifies anyone."
    ),
    "inputSchema": {
        "additionalProperties": False,
        "properties": {
            "correlation_id": {"type": "string"},
            "period_start": {"type": "string"},
            "period_end": {"type": "string"},
            "shifts": {"type": "array"},
            "gaps": {"type": "array"},
            "proposals": {"type": "array"},
        },
        "required": ["correlation_id", "period_start", "period_end", "gaps", "proposals"],
        "type": "object",
    },
    "name": "narrate_rota",
}


@dataclass(frozen=True)
class NarrateRotaInput:
    correlation_id: str
    period_start: str
    period_end: str
    shifts: list[dict[str, Any]]
    gaps: list[dict[str, Any]]
    proposals: list[dict[str, Any]]

    @classmethod
    def from_arguments(cls, arguments: object) -> "NarrateRotaInput":
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be an object.")

        correlation_id = arguments.get("correlation_id")
        period_start = arguments.get("period_start")
        period_end = arguments.get("period_end")
        if not isinstance(correlation_id, str) or correlation_id.strip() == "":
            raise ValueError("Missing string argument: correlation_id.")
        if not isinstance(period_start, str) or period_start.strip() == "":
            raise ValueError("Missing string argument: period_start.")
        if not isinstance(period_end, str) or period_end.strip() == "":
            raise ValueError("Missing string argument: period_end.")

        shifts = arguments.get("shifts") or []
        gaps = arguments.get("gaps")
        proposals = arguments.get("proposals")
        if not isinstance(shifts, list):
            raise ValueError("shifts must be a list.")
        if not isinstance(gaps, list):
            raise ValueError("gaps must be a list.")
        if not isinstance(proposals, list):
            raise ValueError("proposals must be a list.")

        return cls(
            correlation_id=correlation_id,
            period_start=period_start,
            period_end=period_end,
            shifts=[s for s in shifts if isinstance(s, dict)],
            gaps=[g for g in gaps if isinstance(g, dict)],
            proposals=[p for p in proposals if isinstance(p, dict)],
        )


def narrate_rota(
    arguments: object,
    *,
    gateway_headers: dict[str, str] | None = None,
    llm_gateway_url: str,
    system_prompt_path: Path,
) -> dict[str, Any]:
    tool_input = NarrateRotaInput.from_arguments(arguments)

    haystack = " ".join(
        json.dumps(item, sort_keys=True) for item in (tool_input.gaps + tool_input.proposals)
    )
    if contains_prompt_injection(haystack) or asks_to_mutate(haystack):
        return {"narration": "", "refused": True}

    if not tool_input.gaps and not tool_input.proposals:
        return {
            "narration": "No rota gaps detected for the selected period.",
            "refused": False,
        }

    payload = {
        "messages": [
            {"content": system_prompt_path.read_text(encoding="utf-8"), "role": "system"},
            {
                "content": json.dumps(
                    {
                        "gaps": tool_input.gaps,
                        "period_end": tool_input.period_end,
                        "period_start": tool_input.period_start,
                        "proposals": tool_input.proposals,
                        "shifts": tool_input.shifts,
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
        f"{llm_gateway_url.rstrip('/')}/v1/careos/narrate-rota",
        payload,
        headers=headers,
    )

    narration = _extract_narration(response)
    return {"narration": narration, "refused": False}


def _extract_narration(response: dict[str, Any]) -> str:
    if isinstance(response.get("narration"), str):
        return str(response["narration"]).strip()

    choices = response.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                try:
                    decoded = json.loads(message["content"])
                except json.JSONDecodeError:
                    return str(message["content"]).strip()
                if isinstance(decoded, dict) and isinstance(decoded.get("narration"), str):
                    return str(decoded["narration"]).strip()
    return ""
