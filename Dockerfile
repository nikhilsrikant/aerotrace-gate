# AeroTrace Gate: one image, three roles (web, worker, migrate). Multi-stage, non-root, no build tools at runtime.
# Air-gapped build: point NODE_IMAGE at your internal registry and NPM_REGISTRY at your npm mirror (Artifactory, Nexus).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci --no-audit --no-fund --loglevel=error

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && rm -rf .next/standalone/demo .next/standalone/tests .next/standalone/deploy

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=3.0.0
LABEL org.opencontainers.image.title="AeroTrace Gate" \
      org.opencontainers.image.description="DO-178C audit agents with configurable human approval" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 AEROTRACE_VERSION=${VERSION}
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/aerotrace
COPY docker/healthcheck.mjs /app/healthcheck.mjs
USER 10001:10001
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["/usr/local/bin/aerotrace"]
CMD ["web"]
