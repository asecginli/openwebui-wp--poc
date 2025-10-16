// bridge-api/telegram_mcp_server.js
// Lightweight Model Context Protocol (MCP) server exposing Telegram inbox/send resources.

import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_PORT = 3030;
const MAX_BUFFERED_UPDATES = 100;
const MCP_PROTOCOL_VERSION = "2024-10-01";
const TELEGRAM_INBOX_URI = "resource://telegram.inbox";
const TELEGRAM_SEND_TOOL = "telegram.send";

function coerceNumeric(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normaliseChatId(chatId) {
  if (chatId === null || chatId === undefined) return null;
  return typeof chatId === "string" ? chatId : String(chatId);
}

function formatTelegramUpdate(update) {
  const message =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post ||
    null;

  const chat = message?.chat;
  const from = message?.from;
  const text =
    message?.text ||
    message?.caption ||
    message?.data ||
    "";

  return {
    updateId: update.update_id,
    type: Object.keys(update).find((key) => key !== "update_id") || "unknown",
    text,
    chat: chat
      ? {
          id: normaliseChatId(chat.id),
          type: chat.type,
          title: chat.title,
          username: chat.username,
        }
      : null,
    from: from
      ? {
          id: normaliseChatId(from.id),
          isBot: Boolean(from.is_bot),
          firstName: from.first_name,
          lastName: from.last_name,
          username: from.username,
          languageCode: from.language_code,
        }
      : null,
    timestamp: message?.date
      ? new Date(message.date * 1000).toISOString()
      : new Date().toISOString(),
    raw: update,
  };
}

async function defaultSendMessage({ botToken, chatId, text, options }) {
  if (!botToken) {
    throw new Error("Telegram bot token is not configured");
  }

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...options,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok || data?.ok === false) {
    const description = data?.description || response.statusText;
    throw new Error(`Telegram send failed: ${description}`);
  }
  return data;
}

export function startTelegramMcpServer(options = {}) {
  const {
    botToken,
    allowedChatIds = [],
    port = DEFAULT_PORT,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    logger = console,
    sendMessageFn,
  } = options;

  if (!botToken) {
    logger.warn("[Telegram MCP] Skipping startup because TELEGRAM_BOT_TOKEN is not configured");
    return null;
  }

  const numericPort = coerceNumeric(port, DEFAULT_PORT);
  const pollEvery = Math.max(200, coerceNumeric(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
  const normalisedAllowed = allowedChatIds.map(normaliseChatId).filter(Boolean);
  const updateQueue = [];
  let lastUpdateId = 0;
  let pollingTimer = null;

  const wss = new WebSocketServer({ port: numericPort });
  const sockets = new Set();

  const sendMessage =
    typeof sendMessageFn === "function"
      ? async (chatId, text, options = {}) =>
          sendMessageFn(chatId, text, options)
      : async (chatId, text, options = {}) =>
          defaultSendMessage({ botToken, chatId, text, options });

  function logDebug(message, metadata = {}) {
    if (logger?.debug) {
      logger.debug(`[Telegram MCP] ${message}`, metadata);
    } else if (logger?.log) {
      logger.log(`[Telegram MCP] ${message}`, metadata);
    }
  }

  function logError(message, error) {
    if (logger?.error) {
      logger.error(`[Telegram MCP] ${message}`, error);
    } else if (logger?.log) {
      logger.log(`[Telegram MCP] ${message}`, error);
    }
  }

  function notifyResourceUpdate() {
    const notification = {
      jsonrpc: "2.0",
      method: "resource.updated",
      params: {
        uri: TELEGRAM_INBOX_URI,
        sequence: Date.now(),
      },
    };
    const payload = JSON.stringify(notification);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  async function pollTelegramUpdates() {
    const params = new URLSearchParams({
      timeout: "0",
      limit: "100",
    });
    if (lastUpdateId) {
      params.set("offset", String(lastUpdateId + 1));
    }

    const url = `${TELEGRAM_API_BASE}/bot${botToken}/getUpdates?${params.toString()}`;

    let data;
    try {
      const response = await fetch(url);
      data = await response.json();
      if (!response.ok || data?.ok === false) {
        const description = data?.description || response.statusText;
        throw new Error(`Telegram getUpdates failed: ${description}`);
      }
    } catch (err) {
      logError("Polling error", err);
      return;
    }

    const updates = Array.isArray(data?.result) ? data.result : [];

    let newUpdates = 0;

    for (const update of updates) {
      if (!update || typeof update.update_id !== "number") continue;
      const formatted = formatTelegramUpdate(update);

      const chatId = formatted.chat?.id;
      if (
        normalisedAllowed.length > 0 &&
        (chatId === null || !normalisedAllowed.includes(chatId))
      ) {
        continue;
      }

      updateQueue.push(formatted);
      lastUpdateId = Math.max(lastUpdateId, update.updateId);
      newUpdates += 1;

      if (updateQueue.length > MAX_BUFFERED_UPDATES) {
        updateQueue.splice(0, updateQueue.length - MAX_BUFFERED_UPDATES);
      }
    }

    if (newUpdates > 0) {
      notifyResourceUpdate();
    }
  }

  function startPolling() {
    if (pollingTimer) return;
    pollingTimer = setInterval(pollTelegramUpdates, pollEvery);
    if (typeof pollingTimer.unref === "function") {
      pollingTimer.unref();
    }
    pollTelegramUpdates().catch((err) => logError("Initial polling failure", err));
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  function sendJson(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendErrorResponse(ws, id, code, message, data) {
    sendJson(ws, {
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    });
  }

  async function handleRpc(ws, request) {
    const { id, method, params } = request;

    const respond = (result) => sendJson(ws, { jsonrpc: "2.0", id, result });

    switch (method) {
      case "initialize": {
        return respond({
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: {
            name: "telegram-mcp",
            version: "0.1.0",
          },
          capabilities: {
            resources: {
              list: true,
              read: true,
            },
            tools: {
              list: true,
              call: true,
            },
          },
        });
      }
      case "listResources": {
        return respond({
          resources: [
            {
              uri: TELEGRAM_INBOX_URI,
              name: "Telegram Inbox",
              description:
                "Buffered Telegram updates from getUpdates polling loop",
              mimeType: "application/json",
            },
          ],
        });
      }
      case "readResource": {
        const uri = params?.uri;
        if (uri !== TELEGRAM_INBOX_URI) {
          return sendErrorResponse(
            ws,
            id,
            404,
            `Unknown resource URI: ${uri}`
          );
        }

        const updates = updateQueue.splice(0, updateQueue.length);
        return respond({
          resource: {
            uri: TELEGRAM_INBOX_URI,
            data: {
              json: {
                updates,
                lastUpdateId,
              },
            },
          },
        });
      }
      case "listTools": {
        return respond({
          tools: [
            {
              name: TELEGRAM_SEND_TOOL,
              description: "Send a message via the configured Telegram bot",
              inputSchema: {
                type: "object",
                required: ["chatId", "text"],
                properties: {
                  chatId: {
                    type: ["string", "number"],
                    description: "Target Telegram chat ID",
                  },
                  text: {
                    type: "string",
                    description: "Message text to send",
                  },
                  options: {
                    type: "object",
                    description: "Optional Telegram sendMessage parameters",
                  },
                },
              },
            },
          ],
        });
      }
      case "callTool": {
        const name = params?.name;
        if (name !== TELEGRAM_SEND_TOOL) {
          return sendErrorResponse(
            ws,
            id,
            404,
            `Unknown tool: ${name}`
          );
        }

        const input = params?.arguments || params?.input || params?.data || {};
        const chatId = input.chatId ?? input.chat_id;
        const text = input.text;
        const options = input.options || {};

        if (!chatId) {
          return sendErrorResponse(ws, id, 400, "chatId is required");
        }
        if (!text) {
          return sendErrorResponse(ws, id, 400, "text is required");
        }

        try {
          const result = await sendMessage(chatId, text, options);
          return respond({
            content: [
              {
                type: "json",
                data: result,
              },
            ],
          });
        } catch (err) {
          return sendErrorResponse(ws, id, 500, err.message);
        }
      }
      case "ping": {
        return respond({ ok: true, timestamp: Date.now() });
      }
      default: {
        return sendErrorResponse(
          ws,
          id,
          501,
          `Method ${method} is not implemented`
        );
      }
    }
  }

  wss.on("connection", (ws) => {
    sockets.add(ws);
    logDebug("Client connected", { totalClients: sockets.size });

    ws.on("message", async (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch (err) {
        sendErrorResponse(ws, null, 400, "Invalid JSON");
        return;
      }

      if (parsed?.jsonrpc !== "2.0") {
        sendErrorResponse(ws, parsed?.id ?? null, 400, "Invalid JSON-RPC envelope");
        return;
      }

      try {
        await handleRpc(ws, parsed);
      } catch (err) {
        logError("RPC handling error", err);
        sendErrorResponse(ws, parsed?.id ?? null, 500, err.message);
      }
    });

    ws.on("close", () => {
      sockets.delete(ws);
      logDebug("Client disconnected", { totalClients: sockets.size });
    });

    ws.on("error", (err) => {
      logError("WebSocket error", err);
    });
  });

  wss.on("listening", () => {
    logger.log(
      `[Telegram MCP] Listening on ws://0.0.0.0:${numericPort} (poll every ${pollEvery}ms)`
    );
  });

  wss.on("close", () => {
    logDebug("WebSocket server closed");
    stopPolling();
  });

  startPolling();

  return {
    port: numericPort,
    close: () =>
      new Promise((resolve, reject) => {
        stopPolling();
        wss.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
  };
}

