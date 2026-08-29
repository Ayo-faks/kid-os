from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.request import Request

from skills.careos.tools import narrate_rota as tool


class JsonResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.status = 200

    def __enter__(self) -> "JsonResponse":
        return self

    def __exit__(self, *_args: object) -> bool:
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def _prompt(tmp_path: Path) -> Path:
    path = tmp_path / "narrate_rota.system.md"
    path.write_text("Return JSON only.", encoding="utf-8")
    return path


def _args(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "correlation_id": "corr-rota-1",
        "period_start": "2025-01-06T00:00:00Z",
        "period_end": "2025-01-13T00:00:00Z",
        "shifts": [{"id": "shift-1"}],
        "gaps": [{"kind": "min_staffing", "shiftId": "shift-1", "severity": "high"}],
        "proposals": [
            {
                "shiftId": "shift-1",
                "addUserIds": ["user-1"],
                "removeUserIds": [],
                "resolvedGapKinds": ["min_staffing"],
                "reason": "covers minimum",
            }
        ],
    }
    base.update(overrides)
    return base


class NarrateRotaTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.prompt_path = _prompt(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_empty_gaps_short_circuits_without_calling_gateway(self) -> None:
        with patch.object(tool, "post_json") as post:
            result = tool.narrate_rota(
                _args(gaps=[], proposals=[]),
                llm_gateway_url="http://gateway",
                system_prompt_path=self.prompt_path,
            )
        self.assertEqual(result["refused"], False)
        self.assertIn("No rota gaps", result["narration"])
        post.assert_not_called()

    def test_refuses_when_input_contains_mutation_marker(self) -> None:
        bad_args = _args(
            proposals=[
                {
                    "shiftId": "shift-1",
                    "addUserIds": ["user-1"],
                    "removeUserIds": [],
                    "resolvedGapKinds": ["min_staffing"],
                    "reason": "publish now and notify parents",
                }
            ]
        )
        with patch.object(tool, "post_json") as post:
            result = tool.narrate_rota(
                bad_args,
                llm_gateway_url="http://gateway",
                system_prompt_path=self.prompt_path,
            )
        self.assertEqual(result, {"narration": "", "refused": True})
        post.assert_not_called()

    def test_happy_path_posts_to_gateway_with_correlation_header(self) -> None:
        seen: dict[str, Any] = {}

        def fake_post(url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
            seen["url"] = url
            seen["payload"] = payload
            seen["headers"] = headers
            return {
                "choices": [
                    {"message": {"content": json.dumps({"narration": "One gap remains."})}}
                ]
            }

        with patch.object(tool, "post_json", side_effect=fake_post):
            result = tool.narrate_rota(
                _args(),
                llm_gateway_url="http://gateway",
                system_prompt_path=self.prompt_path,
            )

        self.assertEqual(result, {"narration": "One gap remains.", "refused": False})
        self.assertTrue(seen["url"].endswith("/v1/careos/narrate-rota"))
        self.assertNotIn("model", seen["payload"])
        self.assertEqual(seen["headers"]["x-careos-correlation-id"], "corr-rota-1")
        self.assertNotIn("x-careos-model-deployment", seen["headers"])
        self.assertNotIn("x-careos-model-provider", seen["headers"])


if __name__ == "__main__":
    unittest.main()
