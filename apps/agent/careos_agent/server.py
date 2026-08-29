from __future__ import annotations

import json
import os
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from skills.careos.tools.draft_email import DRAFT_EMAIL_TOOL, draft_email
from skills.careos.tools.draft_incident_from_text import (
    DRAFT_INCIDENT_FROM_TEXT_TOOL,
    LIST_FORM_TEMPLATES_TOOL,
    draft_incident_from_text,
    list_form_templates,
    mcp_content,
)
from skills.careos.tools.narrate_rota import NARRATE_ROTA_TOOL, narrate_rota
from skills.careos.tools.summarize_handover import SUMMARIZE_HANDOVER_TOOL, summarize_handover


PING_TOOL: dict[str, Any] = {
    "description": "Phase 0 liveness tool for the CareOS Hermes service.",
    "inputSchema": {
        "additionalProperties": False,
        "properties": {"message": {"type": "string"}},
        "type": "object",
    },
    "name": "ping",
}

TOOLS = {
    "ping": PING_TOOL,
    "list_form_templates": LIST_FORM_TEMPLATES_TOOL,
    "draft_incident_from_text": DRAFT_INCIDENT_FROM_TEXT_TOOL,
    "summarize_handover": SUMMARIZE_HANDOVER_TOOL,
    "draft_email": DRAFT_EMAIL_TOOL,
    "narrate_rota": NARRATE_ROTA_TOOL,
}


@dataclass(frozen=True)
class Settings:
    config_path: Path
    host: str
    llm_gateway_url: str
    llm_gateway_service_token: str
    mcp_url: str
    port: int
    handover_system_prompt_path: Path
    draft_email_system_prompt_path: Path
    narrate_rota_system_prompt_path: Path
    system_prompt_path: Path
    skill_path: Path


def load_settings(env: os._Environ[str] | dict[str, str] = os.environ) -> Settings:
    return Settings(
        config_path=Path(env.get("HERMES_CONFIG", "/app/config.yaml")),
        host=env.get("HERMES_HOST", "0.0.0.0"),
        llm_gateway_url=env.get("LLM_GATEWAY_URL", "http://llm-gateway:8080"),
        llm_gateway_service_token=env.get("LLM_GATEWAY_SERVICE_TOKEN", "change-me"),
        mcp_url=env.get("HERMES_MCP_URL", "http://api:3000/mcp"),
        port=int(env.get("HERMES_PORT", env.get("PORT", "8080"))),
        handover_system_prompt_path=Path(
            env.get(
                "HERMES_SUMMARIZE_HANDOVER_SYSTEM_PROMPT",
                "/app/skills/careos/prompts/summarize_handover.system.md",
            )
        ),
        draft_email_system_prompt_path=Path(
            env.get(
                "HERMES_DRAFT_EMAIL_SYSTEM_PROMPT",
                "/app/skills/careos/prompts/draft_email.system.md",
            )
        ),
        narrate_rota_system_prompt_path=Path(
            env.get(
                "HERMES_NARRATE_ROTA_SYSTEM_PROMPT",
                "/app/skills/careos/prompts/narrate_rota.system.md",
            )
        ),
        skill_path=Path(env.get("HERMES_CAREOS_SKILL", "/app/skills/careos/SKILL.md")),
        system_prompt_path=Path(
            env.get(
                "HERMES_DRAFT_INCIDENT_SYSTEM_PROMPT",
                "/app/skills/careos/prompts/draft_incident.system.md",
            )
        ),
    )


class HermesRequestHandler(BaseHTTPRequestHandler):
    server_version = "CareOSHermes/0.0"

    @property
    def settings(self) -> Settings:
        return self.server.settings  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/health":
            self.write_text(HTTPStatus.OK, "ok\n")
            return

        if path == "/ready":
            self.write_json(HTTPStatus.OK, self.readiness_payload())
            return

        if path == "/mcp":
            self.write_json(HTTPStatus.OK, self.tool_list())
            return

        if path == "/ping":
            self.write_json(HTTPStatus.OK, self.ping({}))
            return

        self.write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        if path == "/v1/chat/completions":
            self.stream_chat_completion()
            return

        if path != "/mcp":
            self.write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        request = self.read_json_body()
        method = request.get("method")
        request_id = request.get("id")

        if method == "tools/list":
            self.write_json(HTTPStatus.OK, {"id": request_id, "jsonrpc": "2.0", "result": self.tool_list()})
            return

        if method == "tools/call":
            params = request.get("params")
            if not isinstance(params, dict) or not isinstance(params.get("name"), str):
                self.write_json(HTTPStatus.OK, self.jsonrpc_error(request_id, -32602, "Unknown tool."))
                return

            name = params["name"]
            arguments = params.get("arguments")
            try:
                result = self.call_tool(name, arguments)
            except ValueError as error:
                self.write_json(HTTPStatus.OK, self.jsonrpc_error(request_id, -32602, str(error)))
                return

            self.write_json(HTTPStatus.OK, {"id": request_id, "jsonrpc": "2.0", "result": result})
            return

        self.write_json(HTTPStatus.OK, self.jsonrpc_error(request_id, -32601, "Method not found."))

    def stream_chat_completion(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        headers = {
            "accept": "text/event-stream",
            "content-type": "application/json",
            "x-careos-gateway-token": self.settings.llm_gateway_service_token,
        }
        for name in (
            "x-careos-correlation-id",
            "x-careos-home-id",
            "x-careos-tenant-id",
            "x-careos-user-id",
        ):
            value = self.headers.get(name)
            if value:
                headers[name] = value

        request = Request(
            f"{self.settings.llm_gateway_url.rstrip('/')}/v1/careos/chat.general",
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urlopen(request, timeout=300) as response:
                self.send_response(response.status)
                self.send_header("cache-control", "no-cache, no-transform")
                self.send_header("content-type", "text/event-stream; charset=utf-8")
                self.send_header("x-accel-buffering", "no")
                self.end_headers()
                while True:
                    # read1 relays each upstream chunk as soon as it arrives;
                    # read(n) would buffer until n bytes or EOF, stalling the
                    # stream for the whole generation and tripping downstream
                    # body timeouts.
                    chunk = response.read1(8192)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
        except HTTPError as error:
            self.write_gateway_error(error.code, error.read())
        except (TimeoutError, URLError, OSError):
            self.write_gateway_error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                json.dumps(
                    {
                        "error": {
                            "code": "provider_unavailable",
                            "message": "The configured model provider is temporarily unavailable.",
                            "retryable": True,
                        }
                    }
                ).encode("utf-8"),
            )

    def write_gateway_error(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def readiness_payload(self) -> dict[str, Any]:
        return {
            "checks": {
                "careosMcp": self.check_url(self.settings.mcp_url),
                "config": "ok" if self.settings.config_path.exists() else "missing",
                "skill": "ok" if self.settings.skill_path.exists() else "missing",
                "handoverSystemPrompt": "ok"
                if self.settings.handover_system_prompt_path.exists()
                else "missing",
                "draftEmailSystemPrompt": "ok"
                if self.settings.draft_email_system_prompt_path.exists()
                else "missing",
                "narrateRotaSystemPrompt": "ok"
                if self.settings.narrate_rota_system_prompt_path.exists()
                else "missing",
                "systemPrompt": "ok" if self.settings.system_prompt_path.exists() else "missing",
            },
            "llmGatewayUrl": self.settings.llm_gateway_url,
            "status": "ok",
        }

    def tool_list(self) -> dict[str, Any]:
        return {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "careos-hermes", "version": "0.0.0"},
            "tools": list(TOOLS.values()),
        }

    def call_tool(self, name: str, arguments: object) -> dict[str, Any]:
        if name == "ping":
            return self.ping(arguments)
        if name == "list_form_templates":
            return mcp_content(list_form_templates(self.settings.mcp_url))
        if name == "draft_incident_from_text":
            return mcp_content(
                draft_incident_from_text(
                    arguments,
                    gateway_headers=self.gateway_headers(),
                    llm_gateway_url=self.settings.llm_gateway_url,
                    mcp_url=self.settings.mcp_url,
                    system_prompt_path=self.settings.system_prompt_path,
                )
            )
        if name == "summarize_handover":
            return mcp_content(
                summarize_handover(
                    arguments,
                    gateway_headers=self.gateway_headers(),
                    llm_gateway_url=self.settings.llm_gateway_url,
                    mcp_url=self.settings.mcp_url,
                    system_prompt_path=self.settings.handover_system_prompt_path,
                )
            )
        if name == "draft_email":
            return mcp_content(
                draft_email(
                    arguments,
                    gateway_headers=self.gateway_headers(),
                    llm_gateway_url=self.settings.llm_gateway_url,
                    mcp_url=self.settings.mcp_url,
                    system_prompt_path=self.settings.draft_email_system_prompt_path,
                )
            )
        if name == "narrate_rota":
            return mcp_content(
                narrate_rota(
                    arguments,
                    gateway_headers=self.gateway_headers(),
                    llm_gateway_url=self.settings.llm_gateway_url,
                    system_prompt_path=self.settings.narrate_rota_system_prompt_path,
                )
            )
        raise ValueError("Unknown tool.")

    def gateway_headers(self) -> dict[str, str]:
        headers = {"x-careos-gateway-token": self.settings.llm_gateway_service_token}
        for name in (
            "x-careos-correlation-id",
            "x-careos-home-id",
            "x-careos-tenant-id",
            "x-careos-user-id",
        ):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        return headers

    def ping(self, arguments: object) -> dict[str, Any]:
        message = "pong"
        if isinstance(arguments, dict) and isinstance(arguments.get("message"), str):
            message = arguments["message"]

        return {
            "content": [{"text": message, "type": "text"}],
            "isError": False,
        }

    def check_url(self, url: str) -> str:
        try:
            request = Request(url, headers={"accept": "application/json"}, method="GET")
            with urlopen(request, timeout=2) as response:
                return "ok" if response.status < 500 else "failed"
        except (TimeoutError, URLError, OSError):
            return "failed"

    def read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("content-length", "0"))
        if content_length == 0:
            return {}

        body = self.rfile.read(content_length)
        try:
            value = json.loads(body)
        except json.JSONDecodeError:
            return {}

        return value if isinstance(value, dict) else {}

    def jsonrpc_error(self, request_id: object, code: int, message: str) -> dict[str, Any]:
        return {"error": {"code": code, "message": message}, "id": request_id, "jsonrpc": "2.0"}

    def write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_text(self, status: HTTPStatus, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:
        return


class HermesServer(ThreadingHTTPServer):
    settings: Settings


def run() -> None:
    settings = load_settings()
    server = HermesServer((settings.host, settings.port), HermesRequestHandler)
    server.settings = settings
    print(
        f"[hermes] listening on {settings.host}:{settings.port} "
        f"mcp={settings.mcp_url} llm_gateway={settings.llm_gateway_url}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    run()