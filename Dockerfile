# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (camada cacheável).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Código da aplicação.
COPY src ./src
COPY db ./db
# Scripts de diagnóstico (read-only, rodados à mão com `docker exec`). Sem esta linha,
# `docker exec adr-lead-manager node /app/scripts/...` falha com "Cannot find module".
COPY scripts ./scripts
# Scripts de operação (backfill, heal, dry-run), rodados à mão com `docker exec`, pela MESMA
# razão escrita duas linhas acima — e que esta linha faltava para alcançar.
#
# O que isso custou, em 02/11/2026: o runbook deste repositório manda rodar
# `node deploy/wa-sync-once.js` depois de TODO deploy, porque o dispatcher de webhook não tem
# fila nem retry e mensagem que chega durante o reinício é perdida. O comando não existia no
# container. E rodar no host também falha, por outro motivo: `DATABASE_URL` e o endereço da
# Evolution usam NOMES DE CONTAINER, que o host não resolve (EAI_AGAIN).
#
# ⚠ O modo de falha era silencioso e pior que a ausência: quem seguisse o runbook veria
# "Cannot find module" e poderia concluir que o backfill não era necessário — exatamente quando
# ele é. Duas camadas de "parece que rodou", porque o próprio `--all` devolve `inseridos: 0`
# tanto para "nada faltava" quanto para "não fui ver".
COPY deploy ./deploy

ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002

# Roda como usuário não-root (já existe na imagem node).
USER node

CMD ["node", "src/server.js"]
