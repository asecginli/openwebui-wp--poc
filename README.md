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
   - Go to Users → Profile → Application Passwords
   - Name: "Bridge API"
   - Copy generated password

3. Update Bridge API config:
   ```bash
   # Edit .env file
   WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
   
   # Restart stack
   docker compose up -d
   ```

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
