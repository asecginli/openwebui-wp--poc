// openwebui-wp-poc/bridge-api/server.js

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { body, param, validationResult } from "express-validator";
import { startTelegramMcpServer } from "./telegram_mcp_server.js";

const {
  PORT = 3000,
  API_BASE_URL,
  WP_BASE_URL,
  WP_USER,
  WP_APP_PASSWORD,
  OWUI_ORIGIN,
  BRIDGE_API_KEY,
  AGENT_API_BASE_URL,
  AGENT_API_KEY,
  AGENT_ID,
  AGENT_MODEL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_ALLOWED_CHAT_IDS,
  TELEGRAM_MCP_ENABLED,
  TELEGRAM_MCP_PORT,
  TELEGRAM_MCP_POLL_INTERVAL_MS,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_API_VERSION = "v20.0"
} = process.env;

const app = express();
app.set("trust proxy", 1); // trust first hop (Nginx/Proxy Manager)

app.use(express.json());

const trimmedAgentBaseUrl = AGENT_API_BASE_URL?.replace(/\/+$/, "");
const agentSessions = new Map(); // In-memory tracking of conversation threads per integration session
const telegramAllowedChatIds = (TELEGRAM_ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const isAgentConfigured = () =>
  Boolean(AGENT_API_KEY && (AGENT_ID || AGENT_MODEL));
const TELEGRAM_MAX_MESSAGE_LENGTH = 3900; // Keep under Telegram's 4096 limit to avoid truncation
const WHATSAPP_MAX_MESSAGE_LENGTH = 3900;


app.use((req, _res, next) => {
  console.log('VALVE DEBUG', req.method, req.path, {
    auth: req.headers.authorization,
    xapikey: req.headers['x-api-key']
  });
  next();
});

// OpenWebUI capability probe (public)
// Keeping public avoids 401 during OWUI tool validation
app.get("/valves/user", (_req, res) => {
  res.json({
    name: "wp_api",
    version: "1.0.0",
    features: ["list-posts", "create-post", "delete-post", "update-post"],
  });
});

// Lightweight health probe for uptime monitors
app.get("/ping", (_req, res) => {
  res.json({ status: "ok" });
});

// Modify CORS handling to be more secure and informative
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === OWUI_ORIGIN) {
      callback(null, true);
    } else {
      const corsError = new Error('CORS policy violation');
      corsError.status = 403;
      corsError.details = `Origin ${origin} is not allowed`;
      callback(corsError);
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  credentials: true
}));


// Middleware to check API key for protected endpoints
function requireApiKey(req, res, next) {
  const apiKey = req.headers['authorization']?.replace('Bearer ', '') || 
                 req.headers['x-api-key'];
  if (!apiKey || apiKey !== BRIDGE_API_KEY) {
    return res.status(401).json({ error: `Unauthorized: Invalid API key` });
  }
  next();
}

function wpHeaders() {
  if (!WP_USER || !WP_APP_PASSWORD) {
    const error = new Error("WordPress credentials are not configured");
    error.status = 500;
    throw error;
  }
  const sanitizedPassword = WP_APP_PASSWORD.replace(/\s+/g, "");
  const token = Buffer.from(`${WP_USER}:${sanitizedPassword}`).toString("base64");
  return {
    "Authorization": `Basic ${token}`,
    "Content-Type": "application/json",
    // "X-Bridge-Auth": BRIDGE_API_KEY,
    "x-api-keyY": BRIDGE_API_KEY
  };
}

const wpPostsBaseUrl = () => {
  if (!WP_BASE_URL) {
    const error = new Error("WP_BASE_URL is not configured");
    error.status = 500;
    throw error;
  }
  return `${WP_BASE_URL}/wp-json/wp/v2/posts`;
};

async function wpCreatePost({ title, content, status = "publish" }) {
  // WordPress REST API endpoint
  if (!title || !content) {
    const error = new Error("Missing title or content");
    error.status = 400;
    throw error;
  }

  const response = await fetch(wpPostsBaseUrl(), {
    method: "POST",
    headers: wpHeaders(),
    body: JSON.stringify({ title, content, status })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || response.statusText || "Failed to create WordPress post");
    error.status = response.status;
    error.detail = data;
    throw error;
  }

  return data;
}

const agentBaseUrl = () => (trimmedAgentBaseUrl || "https://api.openai.com/v1");

function chunkMessage(text, maxLength) {
  const chunks = [];
  let remaining = (text || "").trim();
  if (!remaining.length) {
    return [""];
  }

  while (remaining.length > maxLength) {
    let chunk = remaining.slice(0, maxLength);
    const lastBreak = chunk.lastIndexOf("\n");
    if (lastBreak > maxLength / 2) {
      chunk = chunk.slice(0, lastBreak);
    }
    chunks.push(chunk.trim());
    remaining = remaining.slice(chunk.length).trimStart();
  }

  if (remaining.length) {
    chunks.push(remaining);
  }

  return chunks;
}

async function callAgent(prompt, { sessionId, metadata } = {}) {
  if (!isAgentConfigured()) {
    throw new Error("Agent integration is not configured");
  }

  const payload = {
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt }
        ]
      }
    ]
  };

  if (AGENT_ID) {
    payload.agent_id = AGENT_ID;
  } else if (AGENT_MODEL) {
    payload.model = AGENT_MODEL;
  }

  const conversationId = sessionId ? agentSessions.get(sessionId) : undefined;
  if (conversationId) {
    payload.conversation = { id: conversationId };
  }

  if (metadata && Object.keys(metadata).length) {
    payload.metadata = metadata;
  }

  const response = await fetch(`${agentBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AGENT_API_KEY}`,
      "OpenAI-Beta": "assistants=v2"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    const detail = data?.error?.message || response.statusText;
    throw new Error(`Agent request failed: ${detail}`);
  }

  const newConversationId = data?.conversation?.id;
  if (sessionId && newConversationId) {
    agentSessions.set(sessionId, newConversationId);
    if (agentSessions.size > 1000) {
      const firstKey = agentSessions.keys().next().value;
      if (firstKey) {
        agentSessions.delete(firstKey);
      }
    }
  }

  const outputSegments = Array.isArray(data?.output) ? data.output : [];
  const text = outputSegments
    .flatMap((segment) =>
      Array.isArray(segment?.content) ? segment.content : []
    )
    .filter(
      (content) =>
        content?.type === "output_text" && typeof content.text === "string"
    )
    .map((content) => content.text)
    .join("\n")
    || data?.output_text
    || data?.response_text
    || "";

  return { text: text.trim(), raw: data };
}

async function telegramSendMessage(chatId, text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Telegram bot token is not configured");
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };

  if (options.replyToMessageId) {
    payload.reply_to_message_id = options.replyToMessageId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();

  if (!response.ok || data?.ok === false) {
    const description = data?.description || response.statusText;
    throw new Error(`Telegram send failed: ${description}`);
  }

  return data;
}

async function telegramSendLongMessage(chatId, text, options = {}) {
  const chunks = chunkMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  let isFirstChunk = true;

  for (const chunk of chunks) {
    if (!chunk) continue;
    const payload = isFirstChunk ? options : {};
    await telegramSendMessage(chatId, chunk, payload);
    isFirstChunk = false;
  }
}

let telegramMcpServerHandle = null;
if (TELEGRAM_MCP_ENABLED === "true") {
  telegramMcpServerHandle = startTelegramMcpServer({
    botToken: TELEGRAM_BOT_TOKEN,
    allowedChatIds: telegramAllowedChatIds,
    port: TELEGRAM_MCP_PORT,
    pollIntervalMs: TELEGRAM_MCP_POLL_INTERVAL_MS,
    logger: console,
    sendMessageFn: async (chatId, text, options = {}) => {
      const chunks = chunkMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH);
      const responses = [];
      let isFirstChunk = true;
      for (const chunk of chunks) {
        if (!chunk) continue;
        const payload = isFirstChunk ? options : {};
        const result = await telegramSendMessage(chatId, chunk, payload);
        responses.push(result);
        isFirstChunk = false;
      }
      return { ok: true, segments: responses.length, results: responses };
    }
  });
}

const whatsappEndpoint = () => {
  if (!WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp phone number ID is not configured");
  }
  return `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
};

async function whatsappSendMessage(to, text) {
  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp access token is not configured");
  }

  const response = await fetch(whatsappEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const detail = data?.error?.message || response.statusText;
    throw new Error(`WhatsApp send failed: ${detail}`);
  }

  return data;
}

async function whatsappSendLongMessage(to, text) {
  const chunks = chunkMessage(text, WHATSAPP_MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    if (!chunk) continue;
    await whatsappSendMessage(to, chunk);
  }
}

const normalizeQuotes = (text = "") =>
  text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");

function parseTelegramInstruction(rawText) {
  if (!rawText) return null;
  const normalized = normalizeQuotes(rawText).trim();
  const lower = normalized.toLowerCase();

  if (!lower.includes("wordpress post")) {
    return null;
  }

  // Currently focused on create workflow.
  const isCreate =
    lower.includes("create a wordpress post") ||
    lower.includes("create wordpress post") ||
    lower.includes("create new wordpress post");
  if (!isCreate) {
    return null;
  }

  const titleMatch = normalized.match(
    /(?:titled|title|called|named)\s*["']([^"']+)["']/
  );
  const contentMatch = normalized.match(
    /(?:content|body|text)\s*["']([^"']+)["']/
  );

  if (!titleMatch || !contentMatch) {
    return null;
  }

  const statusMatch = lower.match(/\b(draft|publish|published|private)\b/);
  let status = "publish";
  if (statusMatch) {
    const statusToken = statusMatch[1];
    if (statusToken === "draft") status = "draft";
    else if (statusToken === "private") status = "private";
  }

  const title = titleMatch[1].trim();
  const content = contentMatch[1].trim();

  if (!title || !content) {
    return null;
  }

  return {
    action: "create_post",
    summary: `Create WordPress post "${title}"`,
    args: { title, content, status }
  };
}

async function executeInstruction(instruction) {
  switch (instruction.action) {
    case "create_post": {
      const data = await wpCreatePost(instruction.args);
      const renderedTitle =
        data?.title?.rendered ||
        (typeof data?.title === "string" ? data.title : instruction.args.title);
      const link = data?.link;
      const status = data?.status || instruction.args.status;
      const id = data?.id;

      let result = `Success: WordPress post created.\nTitle: ${renderedTitle}`;
      if (id != null) result += `\nID: ${id}`;
      if (status) result += `\nStatus: ${status}`;
      if (link) result += `\nLink: ${link}`;
      return result;
    }
    default:
      throw new Error(`Unsupported instruction: ${instruction.action}`);
  }
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later." }
});

app.use(limiter);

// Create a post (protected with API key)
app.post("/posts", 
  requireApiKey,
  body("title").isString().notEmpty(),
  body("content").isString().notEmpty(),
  async (req, res) => {
    console.log("Request Headers:", req.headers);
    console.log("Response Headers:", res.getHeaders());
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    try {
      const { title, content, status = "publish" } = req.body;
      const data = await wpCreatePost({ title, content, status });
      /// log here header 
      console.log("Response Headers:", res.getHeaders());
      res.json(data);
    } catch (e) {
      res.status(e.status || 500).json({ error: "Bridge error", detail: e.message, extra: e.detail });
    }
  }
);

// Get recent posts (public endpoint)
app.get("/posts", async (req, res) => {
  // WordPress REST API endpoint
  const wp_rest_url = `${WP_BASE_URL}/wp-json/wp/v2/posts`;
  try {
    const search = req.query.search || "";
    const page = parseInt(req.query.page) || 1;
    const per_page = parseInt(req.query.per_page) || 10;

    const url = new URL(wp_rest_url);
    if (search) url.searchParams.set("search", search);
    url.searchParams.set("page", page);
    url.searchParams.set("per_page", per_page);

    const r = await fetch(url, {
      headers: wpHeaders() // if you want to retrieve protected fields
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "WP error", detail: data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Bridge error", detail: e.message + " " + wp_rest_url });
  }
});

// Get a post by ID (public endpoint)
app.get("/posts/:id", 
  param("id").isInt().toInt(), // Ensure `id` is an integer
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const postId = req.params.id; // `postId` is now guaranteed to be an integer
    // WordPress REST API endpoint
    const wp_rest_url = `${WP_BASE_URL}/wp-json/wp/v2/posts/${postId}`;
    try {
      const r = await fetch(wp_rest_url, {
        headers: wpHeaders() // if you want to retrieve protected fields
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: "WP error", detail: data });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: "Bridge error", detail: e.message + " " + wp_rest_url });
    }
  }
);

// Update a post by ID (protected with API key)
app.patch("/posts/:id", 
  requireApiKey,
  param("id").isInt().toInt(), // Ensure `id` is an integer
  body("title").optional().isString(),
  body("content").optional().isString(),
  body("status").optional().isString().isIn(["draft", "publish", "private"]),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const postId = req.params.id; // `postId` is now guaranteed to be an integer
    const { title, content, status } = req.body;

    // WordPress REST API endpoint
    const wp_rest_url = `${WP_BASE_URL}/wp-json/wp/v2/posts/${postId}`;

    try {
      const r = await fetch(wp_rest_url, {
        method: "PATCH",
        headers: wpHeaders(),
        body: JSON.stringify({ title, content, status })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: "WP error", detail: data });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: "Bridge error", detail: e.message + " " + wp_rest_url });
    }
  }
);

// Delete a post by ID (protected with API key)
app.delete("/posts/:id", 
  requireApiKey,
  param("id").isInt().toInt(), // Ensure `id` is an integer
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const postId = req.params.id; // `postId` is now guaranteed to be an integer
    // WordPress REST API endpoint
    const wp_rest_url = `${WP_BASE_URL}/wp-json/wp/v2/posts/${postId}`;

    try {
      const r = await fetch(wp_rest_url, {
        method: "DELETE",
        headers: wpHeaders()
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: "WP error", detail: data });
      res.json({ message: "Post deleted successfully", data });
    } catch (e) {
      res.status(500).json({ error: "Bridge error", detail: e.message + " " + wp_rest_url });
    }
  }
);

// Telegram webhook endpoint to bridge chats -> agent responses
app.post("/telegram/webhook", async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(501).json({ error: "Telegram integration is not configured" });
  }

  try {
    if (TELEGRAM_WEBHOOK_SECRET) {
      const providedSecret =
        req.query.secret ||
        req.headers["x-telegram-secret-token"];
      if (providedSecret !== TELEGRAM_WEBHOOK_SECRET) {
        return res.status(403).json({ error: "Invalid webhook secret" });
      }
    }

    const update = req.body || {};
    const message =
      update.message ||
      update.edited_message ||
      update.channel_post ||
      update.edited_channel_post;

    if (!message?.text) {
      return res.json({ ok: true });
    }

    const chatIdRaw = message.chat?.id;
    const chatId = chatIdRaw != null ? String(chatIdRaw) : null;
    if (!chatId) {
      return res.json({ ok: true });
    }

    if (telegramAllowedChatIds.length && !telegramAllowedChatIds.includes(chatId)) {
      console.warn(`Ignoring Telegram chat ${chatId} (not allow-listed)`);
      return res.json({ ok: true });
    }

    const prompt = message.text.trim();
    if (!prompt) {
      return res.json({ ok: true });
    }

    const instruction = parseTelegramInstruction(prompt);
    if (instruction) {
      try {
        const executionReply = await executeInstruction(instruction);
        await telegramSendLongMessage(
          chatId,
          executionReply,
          { replyToMessageId: message.message_id }
        );
      } catch (instructionError) {
        console.error("Telegram instruction execution error", instructionError);
        const failureMessage =
          "Warning: I could not complete that WordPress task: " +
          (instructionError?.message || "Unknown error.");
        await telegramSendLongMessage(
          chatId,
          failureMessage,
          { replyToMessageId: message.message_id }
        );
      }
      return res.json({ ok: true });
    }

    if (!isAgentConfigured()) {
      await telegramSendLongMessage(
        chatId,
        "Agent integration is not configured yet. Please contact the administrator.",
        { replyToMessageId: message.message_id }
      );
      return res.json({ ok: true });
    }

    try {
      const agentResponse = await callAgent(prompt, {
        sessionId: `telegram:${chatId}`,
        metadata: {
          platform: "telegram",
          chat_id: chatId,
          username: message.from?.username,
          first_name: message.from?.first_name,
          last_name: message.from?.last_name
        }
      });

      const replyText = agentResponse.text || "The agent did not return any content.";
      await telegramSendLongMessage(
        chatId,
        replyText,
        { replyToMessageId: message.message_id }
      );
    } catch (agentError) {
      console.error("Telegram agent processing error", agentError);
      await telegramSendLongMessage(
        chatId,
        "There was a problem contacting the agent. Please try again later.",
        { replyToMessageId: message.message_id }
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Telegram webhook error", err);
    res.status(200).json({ ok: true });
  }
});

// WhatsApp webhook verification (Meta requirement)
app.get("/whatsapp/webhook", (req, res) => {
  if (!WHATSAPP_VERIFY_TOKEN) {
    return res.status(501).send("WhatsApp integration is not configured");
  }

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  res.status(403).send("Forbidden");
});

// WhatsApp webhook receiver (Meta Cloud API)
app.post("/whatsapp/webhook", async (req, res) => {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    return res.status(501).json({ error: "WhatsApp integration is not configured" });
  }

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const contact = contacts[0];

      for (const message of messages) {
        if (message.type !== "text" || !message.text?.body) {
          continue;
        }

        const from = message.from;
        const prompt = message.text.body.trim();
        if (!from || !prompt) {
          continue;
        }

        if (!isAgentConfigured()) {
          await whatsappSendLongMessage(
            from,
            "Agent integration is not configured yet. Please contact the administrator."
          );
          continue;
        }

        try {
          const agentResponse = await callAgent(prompt, {
            sessionId: `whatsapp:${from}`,
            metadata: {
              platform: "whatsapp",
              phone: from,
              profile_name: contact?.profile?.name
            }
          });

          const replyText = agentResponse.text || "The agent did not return any content.";
          await whatsappSendLongMessage(from, replyText);
        } catch (agentError) {
          console.error("WhatsApp agent processing error", agentError);
          await whatsappSendLongMessage(
            from,
            "There was a problem contacting the agent. Please try again later."
          );
        }
      }
    }
  }

  res.sendStatus(200);
});

const openapiSpec = {
  openapi: "3.0.0",
  info: {
    title: "WordPress REST API Bridge",
    version: "1.0.0",
    description: "Bridge API for WordPress content management via OpenWebUI"
  },
  servers: [
    {
      url: process.env.API_BASE_URL,
      description: "WordPress Bridge API server"
    }
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key"
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer"
      }
    }
  },
  paths: {
    "/ping": {
      get: {
        summary: "API heartbeat",
        description: "Simple health probe that returns a JSON payload when the service is up.",
        responses: {
          "200": {
            description: "Service is reachable",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/posts": {
      get: {
        summary: "List WordPress posts",
        description: "Retrieve a list of WordPress posts with optional search and pagination.",
        parameters: [
          {
            name: "per_page",
            in: "query",
            description: "Number of posts to return",
            schema: { type: "integer", default: 10, maximum: 50 }
          },
          {
            name: "page",
            in: "query", 
            description: "Page number of results",
            schema: { type: "integer", default: 1 }
          },
          {
            name: "search",
            in: "query",
            description: "Search term to filter posts",
            schema: { type: "string" }
          }
        ],
        responses: {
          "200": {
            description: "Successful response with array of posts",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      title: { type: "object" },
                      content: { type: "object" },
                      excerpt: { type: "object" },
                      date: { type: "string" },
                      link: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        summary: "Create a new WordPress post",
        description: "Create a new WordPress blog post. Requires authentication.",
        security: [
          { "ApiKeyAuth": [] },
          { "BearerAuth": [] }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { 
                    type: "string",
                    description: "The title of the blog post" 
                  },
                  content: { 
                    type: "string",
                    description: "The content/body of the blog post" 
                  },
                  status: { 
                    type: "string", 
                    enum: ["draft", "publish", "private"],
                    default: "publish",
                    description: "Publication status of the post"
                  }
                },
                required: ["title", "content"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Post created successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    title: { type: "object" },
                    content: { type: "object" },
                    link: { type: "string" },
                    status: { type: "string" }
                  }
                }
              }
            }
          },
          "401": {
            description: "Unauthorized (invalid or missing API key)"
          },
          "400": {
            description: "Bad request (missing title or content)"
          }
        }
      }
    },
    "/posts/{id}": {
      get: {
        summary: "Get a WordPress post by ID",
        description: "Retrieve a single WordPress post by its ID.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "The ID of the WordPress post",
            schema: { type: "integer" }
          }
        ],
        responses: {
          "200": {
            description: "Successful response with the post data",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    title: { type: "object" },
                    content: { type: "object" },
                    excerpt: { type: "object" },
                    date: { type: "string" },
                    link: { type: "string" }
                  }
                }
              }
            }
          },
          "404": {
            description: "Post not found"
          }
        }
      },
      patch: {
        summary: "Update a WordPress post by ID",
        description: "Partially update a WordPress post by its ID. Requires authentication.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "The ID of the WordPress post",
            schema: { type: "integer" }
          }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { 
                    type: "string",
                    description: "The new title of the blog post"
                  },
                  content: { 
                    type: "string",
                    description: "The new content/body of the blog post"
                  },
                  status: { 
                    type: "string",
                    enum: ["draft", "publish", "private"],
                    description: "The new publication status of the post"
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Post updated successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    title: { type: "object" },
                    content: { type: "object" },
                    status: { type: "string" },
                    link: { type: "string" }
                  }
                }
              }
            }
          },
          "400": {
            description: "Bad request (invalid input)"
          },
          "401": {
            description: "Unauthorized (invalid or missing API key)"
          },
          "404": {
            description: "Post not found"
          }
        }
      },
      delete: {
        summary: "Delete a WordPress post by ID",
        description: "Delete a WordPress post by its ID. Requires authentication.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "The ID of the WordPress post",
            schema: { type: "integer" }
          }
        ],
        responses: {
          "200": {
            description: "Post deleted successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    data: { type: "object" }
                  }
                }
              }
            }
          },
          "400": {
            description: "Bad request (invalid input)"
          },
          "401": {
            description: "Unauthorized (invalid or missing API key)"
          },
          "404": {
            description: "Post not found"
          }
        }
      }
    },
    "/telegram/webhook": {
      post: {
        summary: "Telegram webhook for agent commands",
        description: "Receives Telegram bot updates, forwards user messages to the configured agent, and replies with the agent response.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "Telegram update payload"
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Webhook processed successfully"
          },
          "403": {
            description: "Invalid webhook secret"
          },
          "501": {
            description: "Integration not configured"
          }
        }
      }
    },
    "/whatsapp/webhook": {
      get: {
        summary: "WhatsApp webhook verification",
        description: "Endpoint used by Meta to verify the webhook during setup.",
        parameters: [
          {
            name: "hub.mode",
            in: "query",
            required: false,
            schema: { type: "string" }
          },
          {
            name: "hub.verify_token",
            in: "query",
            required: false,
            schema: { type: "string" }
          },
          {
            name: "hub.challenge",
            in: "query",
            required: false,
            schema: { type: "string" }
          }
        ],
        responses: {
          "200": {
            description: "Verification successful"
          },
          "403": {
            description: "Verification failed"
          },
          "501": {
            description: "Integration not configured"
          }
        }
      },
      post: {
        summary: "WhatsApp webhook for agent commands",
        description: "Receives WhatsApp Cloud API messages, forwards user text to the configured agent, and replies with the agent response.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "WhatsApp webhook payload"
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Webhook processed successfully"
          },
          "501": {
            description: "Integration not configured"
          }
        }
      }
    }
  }
};

// Protect OpenAPI spec if needed
app.get("/openapi.json", requireApiKey, (req, res) => {
  res.json(openapiSpec);
});

// Handle undefined routes
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Custom error logger
const errorLogger = (err, req) => {
  console.error({
    timestamp: new Date().toISOString(),
    error: {
      message: err.message,
      stack: err.stack,
      status: err.status
    },
    request: {
      method: req.method,
      path: req.path,
      query: req.query,
      ip: req.ip
    }
  });
};

// Global error handler
app.use((err, req, res, next) => {
  errorLogger(err, req);

  // Default to 500 if status not set
  const status = err.status || 500;
  
  // Sanitize error message in production
  const isProduction = process.env.NODE_ENV === 'production';
  const message = isProduction ? 
    'An unexpected error occurred' : 
    err.message || 'Internal server error';

  // Send JSON response for API requests
  if (req.accepts('json')) {
    return res.status(status).json({
      error: {
        message,
        status,
        // Only include details in development
        ...((!isProduction && err.details) && {details: err.details})
      }
    });
  }

  // Send HTML response for browser requests
  res.status(status).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Error ${status}</title>
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          padding: 2rem;
          max-width: 800px;
          margin: 0 auto;
          line-height: 1.5;
        }
        .error {
          background: #fff3f3;
          border: 1px solid #ffcdd2;
          border-radius: 4px;
          padding: 1rem;
        }
        .error-code {
          color: #d32f2f;
          font-size: 1.2rem;
          font-weight: bold;
        }
      </style>
    </head>
    <body>
      <div class="error">
        <div class="error-code">Error ${status}</div>
        <p>${message}</p>
        ${!isProduction && err.details ? `<pre>${err.details}</pre>` : ''}
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Bridge running on :${PORT}`);
});
