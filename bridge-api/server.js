// ionos-vm-poc/bridge-api/server.js

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { body, param, validationResult } from "express-validator";

const {
  PORT = 3000,
  API_BASE_URL,
  WP_BASE_URL,
  WP_USER,
  WP_APP_PASSWORD,
  OWUI_ORIGIN,
  BRIDGE_API_KEY
} = process.env;

const app = express();
app.use(express.json());


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

// CORS: allow your OpenWebUI origin from environment variable
app.use(cors({
  // Use the env variable, with a fallback for safety
  origin: OWUI_ORIGIN ,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  credentials: false
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
  const token = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  return {
    "Authorization": `Basic ${token}`,
    "Content-Type": "application/json"
  };
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    // WordPress REST API endpoint
    const wp_rest_url = `${WP_BASE_URL}/wp-json/wp/v2/posts`;

    try {
      const { title, content, status = "publish" } = req.body;
      if (!title || !content) {
        return res.status(400).json({ error: "Missing title or content" });
      }
      
      const r = await fetch(wp_rest_url, {
        method: "POST",
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
      }
    }
  }
};

// Handle undefined routes
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Protect OpenAPI spec if needed
app.get("/openapi.json", requireApiKey, (req, res) => {
  res.json(openapiSpec);
});

app.listen(PORT, () => {
  console.log(`Bridge running on :${PORT}`);
});