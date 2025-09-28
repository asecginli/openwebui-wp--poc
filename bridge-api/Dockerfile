# ionos-vm-poc/bridge-api/Dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
