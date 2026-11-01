# The helper server's image. The build context is apps/helper alone, so the image depends on nothing outside it.
#   docker build --build-arg HELPER_COMMIT=<40 hex> apps/helper
# node 24.22.1 on Alpine 3.23, pinned by its multi-arch index digest (Docker Hub tag API, read 2026-11-01 00:41Z)
FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
ARG HELPER_COMMIT
RUN echo "$HELPER_COMMIT" | grep -Eqx '[0-9a-f]{40}' || { echo "HELPER_COMMIT must be a full 40-hex commit" >&2; exit 1; }
ENV HELPER_COMMIT=$HELPER_COMMIT
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
