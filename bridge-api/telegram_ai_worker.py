"""
Telegram -> AI -> Telegram worker.

Continuously polls the Telegram MCP inbox, detects AI-triggered messages,
forwards them to the configured agent (OpenWebUI / OpenAI compatible),
and sends the agent's reply back via the MCP send tool.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, Protocol, List

import requests
from websocket import create_connection


# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------

DEFAULT_MCP_URI = os.getenv("TELEGRAM_MCP_WS_URL", "ws://bridge-api:3030/")
STATE_FILE = Path(os.getenv("TELEGRAM_STATE_FILE", "data/telegram_state.json"))
POLL_INTERVAL_SECONDS = float(os.getenv("TELEGRAM_POLL_INTERVAL", "2.0"))

AI_PREFIXES = [
    "/ai",
    "!ai",
    ".ai",
    "/askai",
    "/gpt",
]
AI_PHRASES = [
    "ai:",
    "ask ai",
    "ask the ai",
    "dear ai",
    "gpt",
    "assistant please",
]


# ---------------------------------------------------------------------------
# MCP JSON-RPC client (re-uses logic from telegram_mcp_tool)
# ---------------------------------------------------------------------------

class TelegramMcpClient:
    def __init__(self, uri: Optional[str] = None, timeout: float = 15.0) -> None:
        self.uri = (uri or DEFAULT_MCP_URI).rstrip("/") + "/"
        self.timeout = timeout

    def _rpc(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        ws = create_connection(self.uri, timeout=self.timeout)
        try:
            init_id = self._send(ws, "initialize", {})
            self._await_result(ws, init_id)
            target_id = self._send(ws, method, params or {})
            return self._await_result(ws, target_id)
        finally:
            ws.close()

    @staticmethod
    def _send(ws: Any, method: str, params: Dict[str, Any]) -> str:
        request_id = str(os.urandom(8).hex())
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params:
            payload["params"] = params
        ws.send(json.dumps(payload))
        return request_id

    def _await_result(self, ws: Any, target_id: Optional[str] = None) -> Dict[str, Any]:
        while True:
            raw = ws.recv()
            if not raw:
                raise RuntimeError("MCP server closed the connection unexpectedly.")

            message = json.loads(raw)
            if "id" not in message:
                continue  # Notification

            if target_id is not None and message["id"] != target_id:
                continue

            if "error" in message:
                err = message["error"]
                detail = err.get("data") or err.get("message")
                raise RuntimeError(f"MCP error ({err.get('code')}): {detail}")

            return message.get("result") or {}

    def read_inbox(self) -> Dict[str, Any]:
        return self._rpc("readResource", {"uri": "resource://telegram.inbox"})

    def send_message(self, chat_id: str, text: str) -> Dict[str, Any]:
        return self._rpc(
            "callTool",
            {
                "name": "telegram.send",
                "arguments": {"chatId": chat_id, "text": text},
            },
        )


# ---------------------------------------------------------------------------
# Conversation state & persistence
# ---------------------------------------------------------------------------

@dataclass
class WorkerState:
    last_update_id: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {"last_update_id": self.last_update_id}

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WorkerState":
        return cls(last_update_id=int(data.get("last_update_id", 0)))


class StateStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> WorkerState:
        if self.path.exists():
            try:
                with self.path.open("r", encoding="utf-8") as fh:
                    return WorkerState.from_dict(json.load(fh))
            except Exception as exc:  # pragma: no cover
                logging.warning("Failed to load state file %s: %s", self.path, exc)
        return WorkerState()

    def save(self, state: WorkerState) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(".tmp")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(state.to_dict(), fh)
        tmp_path.replace(self.path)


# ---------------------------------------------------------------------------
# Agent client (OpenAI-style Responses API, compatible with OpenWebUI Agents)
# ---------------------------------------------------------------------------

class AgentBackend(Protocol):
    def generate(self, prompt: str, session_id: Optional[str] = None) -> str: ...


class OpenAIResponsesClient:
    def __init__(self) -> None:
        base_url = os.getenv("OPENAI_API_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        api_key = os.getenv("OPENAI_API_KEY")
        agent_id = os.getenv("OPENAI_AGENT_ID")
        model = os.getenv("OPENAI_MODEL")

        if not api_key:
            raise RuntimeError("AGENT_API_KEY is required to contact the LLM.")
        if not agent_id and not model:
            raise RuntimeError("Set AGENT_ID or AGENT_MODEL for the agent client.")

        self.base_url = base_url
        self.api_key = api_key
        self.agent_id = agent_id
        self.model = model
        self.session_lookup: Dict[str, str] = {}

    def generate(self, prompt: str, session_id: Optional[str] = None) -> str:
        payload: Dict[str, Any] = {
            "input": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}],
                }
            ]
        }
        if self.agent_id:
            payload["agent_id"] = self.agent_id
        else:
            payload["model"] = self.model

        if session_id:
            conversation_id = self.session_lookup.get(session_id)
            if conversation_id:
                payload["conversation"] = {"id": conversation_id}

        response = requests.post(
            f"{self.base_url}/responses",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "OpenAI-Beta": "assistants=v2",
            },
            json=payload,
            timeout=90,
        )

        data = response.json()
        if not response.ok:
            detail = data.get("error", {}).get("message") or response.text
            raise RuntimeError(f"Agent request failed: {detail}")

        conversation_id = data.get("conversation", {}).get("id")
        if session_id and conversation_id:
            self.session_lookup[session_id] = conversation_id

        # Extract text segments
        text = ""
        for segment in data.get("output", []):
            for content in segment.get("content", []):
                if content.get("type") == "output_text":
                    text += content.get("text", "")
        if not text:
            text = data.get("output_text") or data.get("response_text") or ""
        return text.strip()


class OpenWebUIChatClient:
    def __init__(self) -> None:
        base_url = os.getenv("OPENWEBUI_API_BASE_URL", "").rstrip("/")
        api_key = os.getenv("OPENWEBUI_API_KEY", "").strip()
        model = os.getenv("OPENWEBUI_MODEL") or os.getenv("OPENWEBUI_DEFAULT_MODEL") or "gpt-4o-mini"

        if not base_url:
            raise RuntimeError("OPENWEBUI_API_BASE_URL must be set to use OpenWebUI backend.")
        if not api_key:
            raise RuntimeError("OPENWEBUI_API_KEY must be set to use OpenWebUI backend.")

        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.session_history: Dict[str, List[Dict[str, str]]] = {}
        self.history_limit = int(os.getenv("OPENWEBUI_HISTORY_LIMIT", "20"))

    def generate(self, prompt: str, session_id: Optional[str] = None) -> str:
        messages: List[Dict[str, str]]
        if session_id:
            messages = self.session_history.setdefault(session_id, [])
        else:
            messages = []

        messages.append({"role": "user", "content": prompt})
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
        }

        response = requests.post(
            f"{self.base_url}/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=90,
        )

        data = response.json()
        if not response.ok:
            detail = data.get("error", {}).get("message") or response.text
            raise RuntimeError(f"OpenWebUI request failed: {detail}")

        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("OpenWebUI response did not include any choices.")

        message = choices[0].get("message") or {}
        content = message.get("content", "").strip()
        if not content:
            content = "(Empty response from OpenWebUI)"

        if session_id:
            messages.append({"role": "assistant", "content": content})
            # Trim history if necessary
            if len(messages) > self.history_limit:
                # Preserve alternating structure; keep last N entries
                self.session_history[session_id] = messages[-self.history_limit :]

        return content


class IonosChatCompletionsClient:
    """
    Simple wrapper around the IONOS AI Hub (OpenAI-compatible) chat completions endpoint.
    """

    def __init__(self) -> None:
        base_url = (
            os.getenv("AGENT_API_BASE_URL")
            or os.getenv("AGENT_API_BASE_URL")
            or "https://openai.inference.de-txl.ionos.com/v1"
        ).rstrip("/")
        api_key = os.getenv("AGENT_API_KEY") or os.getenv("AGENT_API_KEY")
        model = (
            os.getenv("AGENT_MODEL")
            or os.getenv("AGENT_MODEL")
            or "openai/gpt-oss-120b"
        )

        if not api_key:
            raise RuntimeError("AGENT_API_KEY (or AGENT_API_KEY) must be set for the IONOS backend.")

        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.session_history: Dict[str, List[Dict[str, str]]] = {}
        self.history_limit = int(os.getenv("AGENT_HISTORY_LIMIT", "20"))

    def generate(self, prompt: str, session_id: Optional[str] = None) -> str:
        messages: List[Dict[str, str]]
        if session_id:
            messages = self.session_history.setdefault(session_id, [])
        else:
            messages = []

        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": float(os.getenv("AGENT_TEMPERATURE", "0.7")),
            "max_tokens": int(os.getenv("AGENT_MAX_TOKENS", "512")),
        }

        response = requests.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=90,
        )

        data = response.json()
        if not response.ok:
            detail = data.get("error", {}).get("message") or response.text
            raise RuntimeError(f"IONOS request failed: {detail}")

        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("IONOS response did not include any choices.")

        message = choices[0].get("message") or {}
        content = (message.get("content") or "").strip()
        if not content:
            content = "(Empty response from IONOS AI Hub)"

        if session_id:
            messages.append({"role": "assistant", "content": content})
            if len(messages) > self.history_limit:
                self.session_history[session_id] = messages[-self.history_limit :]

        return content


def create_agent_backend() -> AgentBackend:
    provider = (os.getenv("AI_PROVIDER") or "openai").strip().lower()
    if provider in {"openwebui", "owui", "webui"}:
        return OpenWebUIChatClient()
    if provider in {"ionos", "ionosai", "ionos-ai"}:
        return IonosChatCompletionsClient()
    return OpenAIResponsesClient()


# ---------------------------------------------------------------------------
# Message parsing & routing
# ---------------------------------------------------------------------------

def extract_ai_instruction(raw_text: str) -> Tuple[bool, str]:
    """
    Determine whether the text targets the AI assistant.
    Returns (should_process, cleaned_instruction).
    """
    if not raw_text:
        return False, ""
    stripped = raw_text.strip()
    lowered = stripped.lower()

    for prefix in AI_PREFIXES:
        if lowered.startswith(prefix):
            remainder = stripped[len(prefix) :].lstrip(" :,-")
            return True, remainder or stripped

    for phrase in AI_PHRASES:
        idx = lowered.find(phrase)
        if idx != -1:
            remainder = stripped[idx + len(phrase) :].lstrip(" :,-")
            return True, remainder or stripped

    return False, ""


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

class TelegramAiWorker:
    def __init__(
        self,
        mcp_client: Optional[TelegramMcpClient] = None,
        agent_client: Optional[AgentBackend] = None,
        state_store: Optional[StateStore] = None,
        poll_interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self.mcp = mcp_client or TelegramMcpClient()
        self.agent = agent_client or create_agent_backend()
        self.state_store = state_store or StateStore(STATE_FILE)
        self.poll_interval = poll_interval
        self._state = self.state_store.load()
        self._running = True

    def stop(self, *_: Any) -> None:
        logging.info("Stop signal received. Shutting down worker.")
        self._running = False

    def run(self) -> None:
        logging.info("Starting Telegram AI worker with last_update_id=%s", self._state.last_update_id)
        signal.signal(signal.SIGINT, self.stop)
        signal.signal(signal.SIGTERM, self.stop)

        while self._running:
            try:
                self._process_cycle()
            except Exception as exc:
                logging.exception("Processing cycle failed: %s", exc)
                time.sleep(min(self.poll_interval * 2, 30))
            time.sleep(self.poll_interval)

        self.state_store.save(self._state)
        logging.info("Worker stopped. State saved to %s", STATE_FILE)

    # ------------------------------------------------------------------

    def _process_cycle(self) -> None:
        inbox = self.mcp.read_inbox()
        updates = (
            inbox.get("resource", {})
            .get("data", {})
            .get("json", {})
            .get("updates", [])
        )
        if not updates:
            return

        logging.debug("Fetched %d update(s) from MCP", len(updates))
        for update in updates:
            update_id = int(update.get("updateId", 0))
            if update_id <= self._state.last_update_id:
                continue

            self._state.last_update_id = update_id
            chat = update.get("chat") or {}
            chat_id = str(chat.get("id"))
            text = update.get("text") or ""

            if not chat_id or not text:
                logging.debug("Skipping update %s (missing chat or text)", update_id)
                continue

            should_process, instruction = extract_ai_instruction(text)
            if not should_process:
                logging.info("Ignored message %s from chat %s: %s", update_id, chat_id, text)
                continue

            prompt = instruction or text
            logging.info("Processing AI message %s from chat %s", update_id, chat_id)

            try:
                response_text = self.agent.generate(prompt, session_id=chat_id)
            except Exception as exc:
                logging.exception("Agent error for chat %s: %s", chat_id, exc)
                self._safe_send(
                    chat_id,
                    "[!] Unable to reach the AI agent right now. Please try again later.",
                )
                continue

            if not response_text:
                response_text = "(No response generated by the AI agent.)"

            self._safe_send(chat_id, response_text)

        self.state_store.save(self._state)

    def _safe_send(self, chat_id: str, message: str) -> None:
        try:
            self.mcp.send_message(chat_id, message)
        except Exception as exc:
            logging.exception("Failed to send Telegram message to %s: %s", chat_id, exc)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def configure_logging() -> None:
    log_level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
        stream=sys.stdout,
    )


def main() -> None:
    configure_logging()
    worker = TelegramAiWorker()
    worker.run()


if __name__ == "__main__":
    main()
