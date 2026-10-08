# SPDX-License-Identifier: Apache-2.0
FROM node:22-slim AS build

WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY tools/eslint-plugin-harness/package.json tools/eslint-plugin-harness/package.json
RUN yarn install --immutable
COPY . .
RUN yarn build
RUN yarn workspaces focus @harness/cli --production \
    && mkdir -p /out/dist /out/packages \
    && cp -a node_modules /out/node_modules \
    && cp -a packages/. /out/packages/ \
    && cp -a packages/cli/dist/. /out/dist/

FROM node:22-slim AS runtime

WORKDIR /app
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001
ENTRYPOINT ["node", "dist/bin.js"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "dist/bin.js", "--version"]
