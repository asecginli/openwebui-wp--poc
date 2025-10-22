// bridge-api/telegram_ai_worker.js
// Telegram -> AI -> Telegram worker implemented in Node.js

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import WebSocket from "ws";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  TELEGRAM_MCP_WS_URL = "ws://bridge-api:3030/",
  TELEGRAM_POLL_INTERVAL = "2.0",
  TELEGRAM_STATE_FILE = "data/telegram_state.json",
  AI_PROVIDER = "ionos",
  AGENT_API_BASE_URL = "https://openai.inference.de-txl.ionos.com/v1",
  AGENT_API_KEY,
  AGENT_MODEL = "openai/gpt-oss-120b",
  AGENT_TEMPERATURE = "0.7",
  AGENT_MAX_TOKENS = "512",
  AGENT_HISTORY_LIMIT = "20",
  AGENT_SYSTEM_PROMPT = "You are a helpful assistant that answers clearly and concisely.",
  OPENWEBUI_API_BASE_URL,
  OPENWEBUI_API_KEY,
  OPENWEBUI_MODEL = "gpt-4o-mini",
  OPENWEBUI_HISTORY_LIMIT = "20",
  OPENAI_API_BASE_URL = "https://api.openai.com/v1",
  OPENAI_API_KEY,
  OPENAI_AGENT_ID,
  OPENAI_MODEL,
  OPENAI_TEMPERATURE = "0.7",
  OPENAI_MAX_TOKENS = "512"
} = process.env;

const POLL_INTERVAL_MS = Math.max(500, Number(TELEGRAM_POLL_INTERVAL) * 1000 || 2000);
const MCP_ENDPOINT = TELEGRAM_MCP_WS_URL.replace(/\/+$/, "") + "/";
const STATE_PATH = path.isAbsolute(TELEGRAM_STATE_FILE)
  ? TELEGRAM_STATE_FILE
  : path.join(__dirname, TELEGRAM_STATE_FILE);

const AI_PREFIXES = ["/ai", "!ai", ".ai", "/askai", "/gpt"];
const AI_PHRASES = ["ai:", "ask ai", "ask the ai", "dear ai", "gpt", "assistant please"];

const logger = new console.Console(process.stdout, process.stderr);

async function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(data);
      return { lastUpdateId: Number(parsed.lastUpdateId) || 0 };
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.warn("[TelegramWorker] Failed to load state:", err);
      }
      return { lastUpdateId: 0 };
    }
  }

  async save(state) {
    await ensureDir(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId() {
  return crypto.randomBytes(8).toString("hex");
}

class McpClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  async rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, { handshakeTimeout: 10000 });
      const initId = randomId();
      let requestId = null;
      let stage = "init";
      let settled = false;

      const cleanup = (err, result) => {
        if (settled) return;
        settled = true;
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        } catch (_) {
          // ignore
        }
        if (err) reject(err);
        else resolve(result);
      };

      ws.on("open", () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: initId, method: "initialize" }));
      });

      ws.on("message", (data) => {
        let payload;
        try {
          payload = JSON.parse(data.toString());
        } catch (err) {
          cleanup(new Error(`Invalid JSON from MCP: ${data}`));
          return;
        }

        if (!("id" in payload)) {
          return; // notification
        }

        if (stage === "init" && payload.id === initId) {
          if (payload.error) {
            cleanup(new Error(`MCP initialize error: ${payload.error.message || "unknown"}`));
            return;
          }
          stage = "request";
          requestId = randomId();
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              method,
              params
            })
          );
          return;
        }

        if (stage === "request" && payload.id === requestId) {
          if (payload.error) {
            cleanup(new Error(`MCP error (${payload.error.code}): ${payload.error.message}`));
            return;
          }
          cleanup(null, payload.result || {});
        }
      });

      ws.on("error", (err) => cleanup(err));
      ws.on("close", () => {
        if (!settled) cleanup(new Error("MCP connection closed before response was received."));
      });
    });
  }

  readInbox() {
    return this.rpc("readResource", { uri: "resource://telegram.inbox" });
  }

  sendMessage(chatId, text) {
    return this.rpc("callTool", {
      name: "telegram.send",
      arguments: { chatId, text }
    });
  }
}

class IonOsClient {
  constructor() {
    if (!AGENT_API_KEY) {
      throw new Error("AGENT_API_KEY is required for ionos provider.");
    }
    this.baseUrl = AGENT_API_BASE_URL.replace(/\/+$/, "");
    this.apiKey = AGENT_API_KEY;
    this.model = AGENT_MODEL;
    this.temperature = Number(AGENT_TEMPERATURE);
    this.maxTokens = Number(AGENT_MAX_TOKENS);
    this.historyLimit = Number(AGENT_HISTORY_LIMIT);
    this.systemPrompt = AGENT_SYSTEM_PROMPT;
    this.histories = new Map();
  }

  _buildHistory(sessionId) {
    if (!sessionId) return [];
    if (!this.histories.has(sessionId)) {
      const initial = [];
      if (this.systemPrompt) {
        initial.push({ role: "system", content: this.systemPrompt });
      }
      this.histories.set(sessionId, initial);
    }
    return this.histories.get(sessionId);
  }

  async generate(prompt, sessionId) {
    const history = this._buildHistory(sessionId);
    const messages = history ? [...history] : [];

    if (!history && this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.error?.message || response.statusText;
      throw new Error(`IONOS request failed: ${detail}`);
    }

    const choice = data?.choices?.[0];
    const content = choice?.message?.content?.trim() || "(Empty response from IONOS AI Hub)";

    if (history) {
      history.push({ role: "user", content: prompt });
      history.push({ role: "assistant", content });
      while (history.length > this.historyLimit) {
        history.shift();
      }
    }

    return content;
  }
}

class OpenWebUIClient {
  constructor() {
    if (!OPENWEBUI_API_BASE_URL) {
      throw new Error("OPENWEBUI_API_BASE_URL is required for openwebui provider.");
    }
    if (!OPENWEBUI_API_KEY) {
      throw new Error("OPENWEBUI_API_KEY is required for openwebui provider.");
    }
    this.baseUrl = OPENWEBUI_API_BASE_URL.replace(/\/+$/, "");
    this.apiKey = OPENWEBUI_API_KEY;
    this.model = OPENWEBUI_MODEL;
    this.historyLimit = Number(OPENWEBUI_HISTORY_LIMIT);
    this.systemPrompt = AGENT_SYSTEM_PROMPT;
    this.histories = new Map();
  }

  _history(sessionId) {
    if (!sessionId) return [];
    if (!this.histories.has(sessionId)) {
      const initial = [];
      if (this.systemPrompt) {
        initial.push({ role: "system", content: this.systemPrompt });
      }
      this.histories.set(sessionId, initial);
    }
    return this.histories.get(sessionId);
  }

  async generate(prompt, sessionId) {
    const history = this._history(sessionId);
    const messages = history ? [...history] : [];
    if (!history && this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await fetch(`${this.baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.error?.message || response.statusText;
      throw new Error(`OpenWebUI request failed: ${detail}`);
    }

    const choice = data?.choices?.[0];
    const content = choice?.message?.content?.trim() || "(Empty response from OpenWebUI)";

    if (history) {
      history.push({ role: "user", content: prompt });
      history.push({ role: "assistant", content });
      while (history.length > this.historyLimit) {
        history.shift();
      }
    }

    return content;
  }
}

class OpenAIResponsesClient {
  constructor() {
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for openai provider.");
    }
    if (!OPENAI_AGENT_ID && !OPENAI_MODEL) {
      throw new Error("Set OPENAI_AGENT_ID or OPENAI_MODEL for openai provider.");
    }
    this.baseUrl = OPENAI_API_BASE_URL.replace(/\/+$/, "");
    this.apiKey = OPENAI_API_KEY;
    this.agentId = OPENAI_AGENT_ID;
    this.model = OPENAI_MODEL;
    this.conversations = new Map();
  }

  async generate(prompt, sessionId) {
    const payload = {
      input: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }]
        }
      ]
    };

    if (this.agentId) {
      payload.agent_id = this.agentId;
    } else {
      payload.model = this.model;
    }

    if (sessionId && this.conversations.has(sessionId)) {
      payload.conversation = { id: this.conversations.get(sessionId) };
    }

    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      const detail = data?.error?.message || response.statusText;
      throw new Error(`OpenAI Responses request failed: ${detail}`);
    }

    const convoId = data?.conversation?.id;
    if (sessionId && convoId) {
      this.conversations.set(sessionId, convoId);
    }

    let text = "";
    for (const segment of data?.output || []) {
      for (const item of segment?.content || []) {
        if (item?.type === "output_text") {
          text += item?.text ?? "";
        }
      }
    }

    if (!text) {
      text = data?.output_text || data?.response_text || "(Empty response from OpenAI)";
    }
    return text.trim();
  }
}

function createAgentClient() {
  const provider = (AI_PROVIDER || "ionos").trim().toLowerCase();
  if (provider === "openwebui" || provider === "owui" || provider === "webui") {
    return new OpenWebUIClient();
  }
  if (provider === "openai") {
    return new OpenAIResponsesClient();
  }
  return new IonOsClient();
}

function extractInstruction(text) {
  if (!text) return { shouldProcess: false, instruction: "" };
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();

  for (const prefix of AI_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).replace(/^[:\s,-]+/, "");
      return { shouldProcess: true, instruction: rest || trimmed };
    }
  }

  for (const phrase of AI_PHRASES) {
    const idx = lowered.indexOf(phrase);
    if (idx !== -1) {
      const rest = trimmed.slice(idx + phrase.length).replace(/^[:\s,-]+/, "");
      return { shouldProcess: true, instruction: rest || trimmed };
    }
  }

  return { shouldProcess: false, instruction: "" };
}

async function main() {
  const stateStore = new StateStore(STATE_PATH);
  const state = await stateStore.load();
  const mcp = new McpClient(MCP_ENDPOINT);
  const agent = createAgentClient();

  let running = true;
  process.on("SIGINT", () => {
    running = false;
    logger.info("[TelegramWorker] SIGINT received, shutting down.");
  });
  process.on("SIGTERM", () => {
    running = false;
    logger.info("[TelegramWorker] SIGTERM received, shutting down.");
  });

  logger.info(`[TelegramWorker] Starting poll loop (interval=${POLL_INTERVAL_MS}ms) last_update_id=${state.lastUpdateId}`);

  while (running) {
    try {
      await processCycle({ mcp, agent, state, stateStore });
    } catch (err) {
      logger.error("[TelegramWorker] Cycle failed:", err);
      await delay(Math.min(POLL_INTERVAL_MS * 2, 30000));
    }
    await delay(POLL_INTERVAL_MS);
  }

  await stateStore.save(state);
  logger.info("[TelegramWorker] Stopped. State persisted.");
}

async function processCycle({ mcp, agent, state, stateStore }) {
  const inbox = await mcp.readInbox();
  const updates = inbox?.resource?.data?.json?.updates || [];
  if (!Array.isArray(updates) || updates.length === 0) {
    return;
  }

  logger.debug?.("[TelegramWorker] Retrieved updates:", updates.length);

  for (const update of updates) {
    const updateId = Number(update?.updateId) || 0;
    if (updateId <= state.lastUpdateId) {
      continue;
    }

    state.lastUpdateId = updateId;

    const chatId = update?.chat?.id != null ? String(update.chat.id) : null;
    const text = update?.text ?? "";

    if (!chatId || !text) {
      logger.debug?.("[TelegramWorker] Skipping update without chat/text", updateId);
      continue;
    }

    const { shouldProcess, instruction } = extractInstruction(text);
    if (!shouldProcess) {
      logger.info(`[TelegramWorker] Ignored chat ${chatId} update ${updateId}: ${text}`);
      continue;
    }

    logger.info(`[TelegramWorker] Processing AI request from chat ${chatId} update ${updateId}`);
    let reply;
    try {
      reply = await agent.generate(instruction || text, chatId);
    } catch (err) {
      logger.error("[TelegramWorker] Agent error:", err);
      reply = "[!] Unable to reach the AI agent right now. Please try again later.";
    }

    try {
      await mcp.sendMessage(chatId, reply || "(No response generated.)");
    } catch (err) {
      logger.error("[TelegramWorker] Failed to send Telegram message:", err);
    }
  }

  await stateStore.save(state);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error("[TelegramWorker] Fatal error:", err);
    process.exit(1);
  });
}
