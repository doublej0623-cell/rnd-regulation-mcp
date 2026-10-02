# Korean Law MCP Server - Docker 배포용

# --- Build Stage ---
# Node 22.12.0 LTS, pinned by immutable multi-architecture manifest digest.
FROM node:22.12.0-alpine@sha256:51eff88af6dff26f59316b6e356188ffa2c422bd3c3b76f2556a2e7e89d080bd AS builder

WORKDIR /app

COPY package*.json ./
# Kordoc keeps native OCR/ML helpers optional.  This server does not import
# them, so do not run transitive postinstall downloaders during image builds.
# Pure-JS annex parsing remains installed and is verified in CI.
RUN npm ci --ignore-scripts --omit=optional

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
COPY company-config ./company-config

RUN npm run build
RUN npm prune --omit=dev --omit=optional --ignore-scripts
RUN npm run verify:annex-runtime

# --- Runtime Stage ---
FROM node:22.12.0-alpine@sha256:51eff88af6dff26f59316b6e356188ffa2c422bd3c3b76f2556a2e7e89d080bd

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/company-config ./company-config

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
# A container is explicitly a remote deployment unit. Bind externally, but
# fail startup unless the operator supplies MCP_AUTH_TOKEN (or deliberately
# opts into MCP_ALLOW_UNAUTHENTICATED_REMOTE at runtime).
ENV MCP_HTTP_HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider "http://localhost:${PORT:-3000}/health" || exit 1

# Cloud platforms such as Render inject PORT at runtime. Keep 3000 as the
# local/container fallback while honoring the platform-provided port.
CMD ["sh", "-c", "node build/index.js --mode sse --port ${PORT:-3000}"]
