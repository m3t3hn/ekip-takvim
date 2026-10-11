# syntax=docker/dockerfile:1

# Node 24 LTS, pinned to a minor so rebuilds don't change it unannounced
# (patch releases still come in). node:sqlite needs 22.13 or newer.

# ---- deps: install exactly what package-lock.json says
FROM node:24.21-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: Next.js standalone server
FROM node:24.21-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime: only the traced server files, run as a non-root user
FROM node:24.21-alpine AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="Ekip Takvim" \
      org.opencontainers.image.description="Who's free when, across everyone's calendars." \
      org.opencontainers.image.source="https://github.com/m3t3hn/ekip-takvim" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/app/data/ekip-takvim.sqlite

# /app/data holds the SQLite database: keep it on a volume. The config is
# optional: /app/config/app.yaml if it's there (mount the folder), else the
# defaults.
RUN apk add --no-cache tini && mkdir -p /app/data && chown node:node /app/data

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node config/app.example.yaml config/app.demo.yaml ./config/
# Backup and restore: see docs/backup-and-restore.md.
COPY --chown=node:node scripts/backup-db.mjs scripts/restore-db.mjs ./scripts/

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
