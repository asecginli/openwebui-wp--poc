# IONOS VM-only PoC (Docker Compose): OpenWebUI + Bridge API + WordPress

This folder contains a working Docker Compose setup:
- **Nginx Proxy Manager** as the reverse proxy + Let's Encrypt SSL
- **OpenWebUI** (LLM chat UI)
- **Bridge API** (Node/Express) that calls the **WordPress REST API**
- **WordPress** (headless CMS) + **MariaDB**

## Quick Start (summary)
1) Install Docker & Docker Compose on your VM.
2) Copy this folder to the VM (e.g., to `/opt/ionos-vm-poc`).
3) Edit `.env.example` → save as `.env` with real values (domain, passwords).
4) Run: `docker compose up -d`
5) Go to `http://YOUR_VM_IP:81` → configure Nginx Proxy Manager admin (set email/password).
6) In NPM, create 3 Proxy Hosts:
   - `chat.YOURDOMAIN` → `http://openwebui:8081`
   - `api.YOURDOMAIN` → `http://bridge-api:3000`
   - `cms.YOURDOMAIN` → `http://wordpress:80`
   Enable SSL (Let's Encrypt) for each.
7) Visit `https://cms.YOURDOMAIN`, finish WP setup. Create an Application Password for your WP admin user.
8) Put that application password in `.env` as `WP_APP_PASSWORD`, then `docker compose up -d` again.
9) Test Bridge:
   - `curl https://api.YOURDOMAIN/health`
   - `curl -X POST https://api.YOURDOMAIN/posts -H "Content-Type: application/json" -d '{"title":"Hello","content":"From Bridge"}'`
10) Open `https://chat.YOURDOMAIN` to use OpenWebUI.

See main chat message for a fully explained step-by-step guide.
