# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (camada cacheável).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Código da aplicação.
COPY src ./src
COPY db ./db

ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002

# Roda como usuário não-root (já existe na imagem node).
USER node

CMD ["node", "src/server.js"]
