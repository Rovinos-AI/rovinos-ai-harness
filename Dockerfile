# SPDX-License-Identifier: Apache-2.0
FROM ghcr.io/jdx/mise:2026.10.4-debian@sha256:2fb7fa9a4120333531a8a70296d4ea152ffd3e7658dcf29ac75774a7d78dec24 AS build

WORKDIR /app
COPY mise.toml ./
RUN mise install node npm:corepack
ENV MISE_AUTO_INSTALL=false
RUN mise exec -- corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY tools/eslint-plugin-harness/package.json tools/eslint-plugin-harness/package.json
RUN mise exec -- yarn install --immutable
COPY . .
RUN mise exec -- yarn build
RUN mise exec -- yarn workspaces focus @harness/cli --production \
    && mkdir -p /out/dist /out/packages \
    && cp -a node_modules /out/node_modules \
    && mkdir -p /out/packages/cli /out/packages/schemas \
    && cp -a packages/cli/package.json packages/cli/dist /out/packages/cli/ \
    && cp -a packages/schemas/package.json packages/schemas/dist /out/packages/schemas/ \
    && cp -a packages/cli/dist/. /out/dist/

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

WORKDIR /app
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001
ENTRYPOINT ["node", "dist/bin.js"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "dist/bin.js", "--version"]
