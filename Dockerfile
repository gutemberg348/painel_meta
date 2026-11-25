# Build e execução usam a mesma versão de Node e a mesma base Linux.
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS dependencies
# O better-sqlite3 pode precisar compilar o módulo nativo para a CPU da VPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/totalk.sqlite
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts/flw-conexao.js scripts/flw-templates.js ./scripts/
COPY scripts/lib ./scripts/lib
RUN install -d -o node -g node -m 0700 /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "src/server.js"]
