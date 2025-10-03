# openwebui-wp-poc//bridge-api/Dockerfile
FROM node:24-alpine3.19
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
