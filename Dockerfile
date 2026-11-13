# syntax=docker/dockerfile:1.7
# Multi-stage build: compile with dev deps, ship only prod deps + compiled JS on distroless.
# Final image: no shell, no package manager, runs as non-root (uid 65532).

FROM node:22.12-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/migrate.ts ./scripts/migrate.ts
RUN npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=384"
COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --chown=nonroot:nonroot migrations ./migrations
COPY --chown=nonroot:nonroot package.json ./
USER nonroot
EXPOSE 8080 9464
# The distroless entrypoint is `node`. Tracing bootstrap loads first so auto-instrumentation can patch modules.
# Override CMD for the worker:   ["--require", "./dist/src/infra/tracing.js", "dist/src/worker.js"]
# and for migrations:           ["dist/scripts/migrate.js"]
CMD ["--require", "./dist/src/infra/tracing.js", "dist/src/server.js"]
