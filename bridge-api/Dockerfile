# openwebui-wp-poc//bridge-api/Dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js telegram_mcp_server.js ./
ENV PORT=3000 \
    TELEGRAM_MCP_PORT=3030
EXPOSE 3000 3030
CMD ["node","server.js"]
