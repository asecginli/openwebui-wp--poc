"""
title: Telegram MCP Tool
author: Codex
version: 0.1.0
requirements: websocket-client
"""

import json
import os
import uuid
from typing import Any, Dict, Optional, Tuple

from pydantic import Field
from websocket import create_connection


DEFAULT_URI = "ws://bridge-api:3030/"
INBOX_RESOURCE = "resource://telegram.inbox"
SEND_TOOL = "telegram.send"


class TelegramMcpClient:
    """Minimal MCP client for one-shot interactions with the Telegram bridge."""

    def __init__(self, uri: Optional[str] = None) -> None:
        self.uri = (uri or os.getenv("TELEGRAM_MCP_WS_URL") or DEFAULT_URI).rstrip("/") + "/"

    # ------------------------------------------------------------------
    # Core JSON-RPC helpers
    # ------------------------------------------------------------------
    def _rpc(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Open a fresh MCP session, send one request, and return the result."""
        ws = create_connection(self.uri, timeout=15)
        try:
            init_id = self._send(ws, "initialize", {})
            self._await_result(ws, init_id)
            return self._send_and_receive(ws, method, params or {})
        finally:
            ws.close()

    @staticmethod
    def _send(ws: Any, method: str, params: Dict[str, Any]) -> str:
        request_id = str(uuid.uuid4())
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params:
            payload["params"] = params
        ws.send(json.dumps(payload))
        return request_id

    def _send_and_receive(self, ws: Any, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        target_id = self._send(ws, method, params)
        return self._await_result(ws, target_id)

    def _await_result(self, ws: Any, target_id: Optional[str] = None) -> Dict[str, Any]:
        """Consume socket messages until we get the response matching target_id."""
        while True:
            raw = ws.recv()
            if not raw:
                raise RuntimeError("MCP server closed the connection unexpectedly.")

            try:
                message = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"MCP server returned invalid JSON: {raw}") from exc

            # Notifications (no id) can be ignored.
            if "id" not in message:
                continue

            if target_id is not None and message["id"] != target_id:
                # Ignore unrelated responses.
                continue

            if "error" in message:
                error = message["error"]
                detail = error.get("data") or error.get("message")
                raise RuntimeError(f"MCP error ({error.get('code')}): {detail}")

            return message.get("result") or {}

    # ------------------------------------------------------------------
    # Public actions
    # ------------------------------------------------------------------
    def read_inbox(self) -> Dict[str, Any]:
        """Retrieve buffered Telegram updates via MCP."""
        return self._rpc("readResource", {"uri": INBOX_RESOURCE})

    def send_message(self, chat_id: str, text: str) -> Dict[str, Any]:
        """Send a Telegram message via the MCP bridge."""
        arguments = {"chatId": chat_id, "text": text}
        return self._rpc("callTool", {"name": SEND_TOOL, "arguments": arguments})

    def list_resources(self) -> Dict[str, Any]:
        return self._rpc("listResources")

    def list_tools(self) -> Dict[str, Any]:
        return self._rpc("listTools")


class TelegramMcpTool:
    def __init__(self, client: Optional[TelegramMcpClient] = None) -> None:
        self.client = client or TelegramMcpClient()

    # ------------------------------------------------------------------
    # Tool methods exposed to OpenWebUI
    # ------------------------------------------------------------------
    def mcp_inbox(self) -> str:
        """Fetch Telegram updates and format them for chat display."""
        data = self.client.read_inbox()
        updates = data.get("resource", {}).get("data", {}).get("json", {}).get("updates", [])
        if not updates:
            return "No pending Telegram messages."

        lines = ["Pending Telegram messages:"]
        for item in updates:
            chat = item.get("chat") or {}
            sender = item.get("from") or {}
            lines.append(
                "\n".join(
                    [
                        f"- update_id: {item.get('updateId')}",
                        f"  chat_id: {chat.get('id')} ({chat.get('type')})",
                        f"  from: {sender.get('username') or sender.get('firstName') or sender.get('id')}",
                        f"  text: {item.get('text') or '[no text]'}",
                    ]
                )
            )
        return "\n".join(lines)

    def mcp_send(self, chat_id: str, text: str) -> str:
        """Send a Telegram message via the MCP bridge."""
        response = self.client.send_message(chat_id, text)
        content = response.get("content") or []
        return json.dumps(content, indent=2, ensure_ascii=False) or "Message sent."

    def mcp_status(self) -> str:
        """Display MCP resources and tools to confirm connectivity."""
        resources = self.client.list_resources().get("resources", [])
        tools = self.client.list_tools().get("tools", [])
        return json.dumps(
            {
                "resources": resources,
                "tools": tools,
            },
            indent=2,
            ensure_ascii=False,
        )


class Tools:
    """Compatibility wrapper exposed to OpenWebUI."""

    def __init__(self) -> None:
        self._impl = TelegramMcpTool()

    def mcp_status(self) -> str:
        """
        Show available MCP resources and tools exposed by the Telegram bridge.
        """
        try:
            return self._impl.mcp_status()
        except Exception as exc:
            return f"Failed to query MCP status: {exc}"

    def mcp_inbox(self) -> str:
        """
        Retrieve buffered Telegram updates via MCP and format them for display.
        """
        try:
            return self._impl.mcp_inbox()
        except Exception as exc:
            return f"Failed to read Telegram inbox: {exc}"

    def mcp_send(
        self,
        chat_id: str = Field(
            ...,
            description="Telegram chat ID (numeric string) that should receive the message.",
        ),
        text: str = Field(..., description="Message body to send to the Telegram chat."),
    ) -> str:
        """
        Send a Telegram message using the MCP bridge.
        """
        try:
            return self._impl.mcp_send(chat_id, text)
        except Exception as exc:
            return f"Failed to send Telegram message: {exc}"


def load_tools() -> Tuple[TelegramMcpTool]:
    return (TelegramMcpTool(),)


__all__ = ["Tools", "TelegramMcpTool", "TelegramMcpClient"]
