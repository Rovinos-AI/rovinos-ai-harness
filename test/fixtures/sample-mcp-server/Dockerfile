# SPDX-License-Identifier: Apache-2.0
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY test/fixtures/sample-mcp-server/package.json ./package.json
COPY test/fixtures/sample-mcp-server/yarn.lock ./yarn.lock
COPY .yarnrc.yml ./.yarnrc.yml
RUN corepack yarn install --immutable
COPY test/fixtures/sample-mcp-server/server.ts ./test/fixtures/sample-mcp-server/server.ts
USER node
EXPOSE 3333
CMD ["node", "--experimental-strip-types", "test/fixtures/sample-mcp-server/server.ts"]
