# The helper server's image, built from the repository root so the helper loads the kit as the package
# @blindfill/kit (the kit's public entry, packages/kit/src/index.ts, at its workspace path):
#   docker build -f apps/helper/Dockerfile --build-arg HELPER_COMMIT=<40 hex> .
# The root .dockerignore lets in only what these COPY lines read. `pnpm deploy` is not used: it copies the kit under
# node_modules, where Node 24 refuses to strip types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
# node 24.22.1 on Alpine 3.23, pinned by its multi-arch index digest (Docker Hub tag API, read 2026-11-01 00:41Z)
FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2 AS deps
WORKDIR /app
# the manifests first, so a source change reuses the install layer
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/helper/package.json apps/helper/
COPY packages/kit/package.json packages/kit/
# pnpm at the root package.json's packageManager (pnpm@10.33.1), through corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm && pnpm --version | grep -qx '10.33.1'
# the helper and what it depends on (the kit and their pinned libraries), as the lockfile has them, no dev dependency
RUN pnpm install --frozen-lockfile --prod --filter "@confidential-trenches/helper..."

FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules/ node_modules/
COPY --from=deps /app/apps/helper/node_modules/ apps/helper/node_modules/
COPY --from=deps /app/packages/kit/node_modules/ packages/kit/node_modules/
COPY packages/kit/package.json packages/kit/
COPY packages/kit/src/ packages/kit/src/
COPY apps/helper/package.json apps/helper/
COPY apps/helper/src/ apps/helper/src/
ARG HELPER_COMMIT
RUN echo "$HELPER_COMMIT" | grep -Eqx '[0-9a-f]{40}' || { echo "HELPER_COMMIT must be a full 40-hex commit" >&2; exit 1; }
ENV HELPER_COMMIT=$HELPER_COMMIT
USER node
WORKDIR /app/apps/helper
EXPOSE 8080
CMD ["node", "src/server.ts"]
