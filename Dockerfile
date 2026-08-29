# Multi-stage build for Node.js whatsapp-worker
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY . .
EXPOSE 4000
CMD ["node", "index.js"]
