from __future__ import annotations

import json
import threading
import unittest
from http import HTTPStatus
from io import BytesIO
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from careos_agent.server import HermesRequestHandler, HermesServer, load_settings


class SettingsTests(unittest.TestCase):
    def test_load_settings_uses_phase0_defaults(self) -> None:
        settings = load_settings({})

        self.assertEqual(settings.host, "0.0.0.0")
        self.assertEqual(settings.port, 8080)
        self.assertEqual(settings.mcp_url, "http://api:3000/mcp")
        self.assertEqual(settings.llm_gateway_url, "http://llm-gateway:8080")


class HandlerTests(unittest.TestCase):
    def test_ping_returns_mcp_content(self) -> None:
        handler = object.__new__(HermesRequestHandler)

        self.assertEqual(
            handler.ping({"message": "hello"}),
            {"content": [{"text": "hello", "type": "text"}], "isError": False},
        )

    def test_tool_list_exposes_ping_tool(self) -> None:
        handler = object.__new__(HermesRequestHandler)

        tool_list = handler.tool_list()

        self.assertEqual(tool_list["serverInfo"], {"name": "careos-hermes", "version": "0.0.0"})
        self.assertEqual(tool_list["tools"][0]["name"], "ping")

    @patch("careos_agent.server.urlopen")
    def test_check_url_reports_ok_for_non_500_response(self, urlopen: Mock) -> None:
        handler = object.__new__(HermesRequestHandler)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.status = HTTPStatus.OK
        urlopen.return_value = response

        self.assertEqual(handler.check_url("http://api:3000/mcp"), "ok")

    @patch("careos_agent.server.urlopen")
    def test_chat_completion_streams_gateway_response_with_context(self, gateway_open: Mock) -> None:
        class StreamResponse:
            status = HTTPStatus.OK

            def __init__(self) -> None:
                self.chunks = iter(
                    (
                        b'data: {"choices":[{"delta":{"content":"Factual reply."}}]}\n\n',
                        b"data: [DONE]\n\n",
                        b"",
                    )
                )

            def __enter__(self) -> "StreamResponse":
                return self

            def __exit__(self, *_args: object) -> bool:
                return False

            def read(self, _size: int = -1) -> bytes:
                raise AssertionError(
                    "stream_chat_completion must use read1 so chunks relay "
                    "immediately instead of buffering the whole generation."
                )

            def read1(self, _size: int = -1) -> bytes:
                return next(self.chunks)

        gateway_open.return_value = StreamResponse()
        settings = load_settings(
            {
                "HERMES_HOST": "127.0.0.1",
                "LLM_GATEWAY_SERVICE_TOKEN": "gateway-test-token",
                "LLM_GATEWAY_URL": "http://llm.test:8080",
            }
        )
        server = HermesServer(("127.0.0.1", 0), HermesRequestHandler)
        server.settings = settings
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            port = server.server_address[1]
            request = Request(
                f"http://127.0.0.1:{port}/v1/chat/completions",
                data=json.dumps(
                    {
                        "messages": [{"content": "Hello", "role": "user"}],
                        "model": "careos.chat.general",
                        "stream": True,
                    }
                ).encode("utf-8"),
                headers={
                    "content-type": "application/json",
                    "x-careos-correlation-id": "corr-chat-1",
                    "x-careos-home-id": "home-1",
                    "x-careos-tenant-id": "tenant-1",
                    "x-careos-user-id": "user-1",
                },
                method="POST",
            )
            with urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, HTTPStatus.OK)
                self.assertEqual(response.headers.get_content_type(), "text/event-stream")
                body = response.read().decode("utf-8")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertIn("Factual reply.", body)
        self.assertEqual(body.count("data: [DONE]"), 1)
        gateway_request = gateway_open.call_args.args[0]
        self.assertIsInstance(gateway_request, Request)
        self.assertEqual(
            gateway_request.full_url,
            "http://llm.test:8080/v1/careos/chat.general",
        )
        headers = {name.lower(): value for name, value in gateway_request.header_items()}
        self.assertEqual(headers["x-careos-gateway-token"], "gateway-test-token")
        self.assertEqual(headers["x-careos-correlation-id"], "corr-chat-1")
        self.assertEqual(headers["x-careos-home-id"], "home-1")
        self.assertEqual(headers["x-careos-tenant-id"], "tenant-1")
        self.assertEqual(headers["x-careos-user-id"], "user-1")

    @patch("careos_agent.server.urlopen")
    def test_chat_completion_propagates_gateway_unavailable(self, gateway_open: Mock) -> None:
        error_body = json.dumps(
            {
                "error": {
                    "code": "provider_unavailable",
                    "message": "The configured model provider is temporarily unavailable.",
                    "retryable": True,
                }
            }
        ).encode("utf-8")
        gateway_open.side_effect = HTTPError(
            "http://llm.test:8080/v1/careos/chat.general",
            HTTPStatus.SERVICE_UNAVAILABLE,
            "Service Unavailable",
            {},
            BytesIO(error_body),
        )
        settings = load_settings(
            {
                "HERMES_HOST": "127.0.0.1",
                "LLM_GATEWAY_SERVICE_TOKEN": "gateway-test-token",
                "LLM_GATEWAY_URL": "http://llm.test:8080",
            }
        )
        server = HermesServer(("127.0.0.1", 0), HermesRequestHandler)
        server.settings = settings
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            port = server.server_address[1]
            request = Request(
                f"http://127.0.0.1:{port}/v1/chat/completions",
                data=json.dumps(
                    {
                        "messages": [{"content": "Hello", "role": "user"}],
                        "model": "careos.chat.general",
                        "stream": True,
                    }
                ).encode("utf-8"),
                headers={"content-type": "application/json"},
                method="POST",
            )
            with self.assertRaises(HTTPError) as raised:
                urlopen(request, timeout=2)
            body = json.loads(raised.exception.read())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(raised.exception.code, HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(body["error"]["code"], "provider_unavailable")
        self.assertTrue(body["error"]["retryable"])

    @patch("careos_agent.server.draft_email")
    def test_mcp_tool_receives_trusted_gateway_context(self, draft_email: Mock) -> None:
        draft_email.return_value = {"form_data": {}, "refused": True}
        settings = load_settings(
            {
                "HERMES_HOST": "127.0.0.1",
                "LLM_GATEWAY_SERVICE_TOKEN": "gateway-test-token",
            }
        )
        server = HermesServer(("127.0.0.1", 0), HermesRequestHandler)
        server.settings = settings
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            port = server.server_address[1]
            request = Request(
                f"http://127.0.0.1:{port}/mcp",
                data=json.dumps(
                    {
                        "id": "rpc-1",
                        "jsonrpc": "2.0",
                        "method": "tools/call",
                        "params": {"arguments": {}, "name": "draft_email"},
                    }
                ).encode("utf-8"),
                headers={
                    "content-type": "application/json",
                    "x-careos-correlation-id": "corr-tool-1",
                    "x-careos-home-id": "home-1",
                    "x-careos-tenant-id": "tenant-1",
                    "x-careos-user-id": "user-1",
                },
                method="POST",
            )
            with urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, HTTPStatus.OK)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(
            draft_email.call_args.kwargs["gateway_headers"],
            {
                "x-careos-correlation-id": "corr-tool-1",
                "x-careos-gateway-token": "gateway-test-token",
                "x-careos-home-id": "home-1",
                "x-careos-tenant-id": "tenant-1",
                "x-careos-user-id": "user-1",
            },
        )


class JsonShapeTests(unittest.TestCase):
    def test_ping_payload_is_json_serializable(self) -> None:
        handler = object.__new__(HermesRequestHandler)

        json.dumps(handler.ping({}))


if __name__ == "__main__":
    unittest.main()