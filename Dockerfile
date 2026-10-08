# SPDX-License-Identifier: Apache-2.0
FROM node:22-slim AS build

WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm deploy --filter @harness/cli --prod /out

FROM node:22-slim AS runtime

ARG HARNESS_VERSION=0.0.0
ENV HARNESS_VERSION=${HARNESS_VERSION}
WORKDIR /app
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001
ENTRYPOINT ["node", "dist/bin.js"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "dist/bin.js", "--version"]
