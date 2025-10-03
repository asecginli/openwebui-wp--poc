// openwebui-wp-poc/bridge-api/server.js

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
  const token = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  return {
    "Authorization": `Basic ${token}`,
    "Content-Type": "application/json",
    "X-Bridge-Auth": BRIDGE_API_KEY
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