# OpenWebUI WordPress Bridge API PoC

A Docker Compose setup integrating OpenWebUI with WordPress via a custom Bridge API.

## Components

- **OpenWebUI**: LLM chat interface
- **Bridge API**: Node/Express middleware
- **WordPress**: Headless CMS backend
- **MariaDB**: WordPress database
- **Nginx Proxy Manager**: Reverse proxy with SSL

## Prerequisites

- Linux VM with Docker and Docker Compose installed
- Domain name pointed to your VM's IP
- Basic understanding of Docker and WordPress

## Installation

1. Clone or copy this repository to your VM:
   ```bash
   git clone <repo-url> /opt/ionos-vm-poc
   cd /opt/ionos-vm-poc
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   nano .env  # Edit with your values
   ```

3. Start the stack:
   ```bash
   docker compose up -d
   ```

## Configuration

### 1. Nginx Proxy Manager

1. Access NPM admin:
   - URL: `http://YOUR_VM_IP:81`
   - Default login: 
     - Email: `admin@example.com`
     - Password: `changeme`

2. Configure proxy hosts:
   | Domain | Forward To | SSL |
   |--------|------------|-----|
   | chat.YOURDOMAIN | http://openwebui:8081 | Enable |
   | api.YOURDOMAIN | http://bridge-api:3000 | Enable |
   | cms.YOURDOMAIN | http://wordpress:80 | Enable |

### 2. WordPress Setup

1. Complete WordPress installation:
   ```
   https://cms.YOURDOMAIN/wp-admin
   ```

2. Create application password:
   - Go to Users > Profile > Application Passwords
   - Name: "Bridge API"
   - Copy generated password

3. Update Bridge API config:
   ```bash
   # Edit .env file
   WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
   
   # Restart stack
   docker compose up -d
   ```

### 3. Agent Builder (OpenAI) Setup

> Required for Telegram/WhatsApp messaging integrations.

1. Create an agent (or choose a model) in the OpenAI Agent Builder (https://platform.openai.com/agents) or via the Responses API.
2. Note the `agent_id` (or model name) and generate an API key with access to that agent.
3. Update `.env`:
   ```bash
   AGENT_API_KEY=sk-...
   AGENT_ID=agent-...
   # Optional fallbacks:
   # AGENT_MODEL=gpt-4.1-mini
   # AGENT_API_BASE_URL=https://api.openai.com/v1
   ```
4. Restart the stack so the Bridge API picks up the new credentials.

### 4. Messaging Integrations (optional)

Both connectors expect the agent configuration above. Populate the relevant environment variables and restart the stack to enable each channel.

#### Telegram Bot

1. Create a bot with @BotFather (https://t.me/BotFather) and copy the token.
2. Update `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=1234567890:token-from-botfather
   TELEGRAM_WEBHOOK_SECRET=choose-a-shared-secret
   TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321  # optional allow list
   ```
3. Restart the stack to load the new variables.
4. Point Telegram at the Bridge webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     --data-urlencode "url=https://api.YOURDOMAIN/integrations/telegram/webhook?secret=$TELEGRAM_WEBHOOK_SECRET"
   ```
5. Send the bot a message. It forwards the text to the configured agent and replies with the agent's response.

##### Optional: MCP Tool inside OpenWebUI

With `TELEGRAM_MCP_ENABLED=true`, OpenWebUI can load the bundled `Telegram MCP Tool`:

- The tool connects to the bridge via `ws://bridge-api:3030/` (override with `TELEGRAM_MCP_WS_URL`).
- Exposed actions:
  - `mcp_status` — verify MCP connectivity and list resources/tools.
  - `mcp_inbox` — pull any buffered Telegram updates.
  - `mcp_send` — send a message to a specific chat ID through the bot.

Enable it from OpenWebUI Admin → Tools once the stack has restarted.

#### WhatsApp Cloud API

1. In the Meta Developer dashboard, enable the WhatsApp product, add a phone number, and generate a permanent access token.
2. Update `.env`:
   ```bash
   WHATSAPP_VERIFY_TOKEN=the-value-you-used-in-meta
   WHATSAPP_ACCESS_TOKEN=EAAG...
   WHATSAPP_PHONE_NUMBER_ID=123456789012345
   WHATSAPP_API_VERSION=v20.0
   ```
3. Restart the stack.
4. In Meta, configure the webhook callback URL to `https://api.YOURDOMAIN/integrations/whatsapp/webhook` and supply the same verify token above.
5. Subscribe the webhook to `messages` events. Incoming user texts are relayed to the agent and the response is sent back via WhatsApp.

## Testing

1. Check Bridge API health:
   ```bash
   curl https://api.YOURDOMAIN/health
   ```

2. Create test post:
   ```bash
   curl -X POST https://api.YOURDOMAIN/posts \
     -H "Content-Type: application/json" \
     -d '{"title":"Hello","content":"From Bridge"}'
   ```

3. Access OpenWebUI:
   ```
   https://chat.YOURDOMAIN
   ```

## Architecture

```
Client → Nginx Proxy Manager → OpenWebUI → Bridge API → WordPress → MariaDB
                            ↳ Direct WordPress access (admin)
```

## Security Notes

- All services are behind SSL
- WordPress admin accessible only through HTTPS
- Bridge API uses application passwords
- Internal services not exposed directly

## Troubleshooting

- Check Docker logs: `docker compose logs -f [service]`
- Verify SSL certificates in Nginx Proxy Manager
- Ensure all environment variables are set correctly
- Check WordPress application password is valid


