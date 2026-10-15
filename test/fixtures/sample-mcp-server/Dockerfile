# SPDX-License-Identifier: Apache-2.0
FROM ghcr.io/jdx/mise:2026.10.4-debian@sha256:2fb7fa9a4120333531a8a70296d4ea152ffd3e7658dcf29ac75774a7d78dec24 AS manifests
WORKDIR /src
COPY packages packages
COPY tools tools
RUN mkdir -p /manifests \
    && find packages tools -name package.json -not -path "*/node_modules/*" -exec cp --parents {} /manifests/ \;

FROM ghcr.io/jdx/mise:2026.10.4-debian@sha256:2fb7fa9a4120333531a8a70296d4ea152ffd3e7658dcf29ac75774a7d78dec24 AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential=12.12 python3=3.13.5-1 \
    && rm -rf /var/lib/apt/lists/*
COPY mise.toml ./
RUN mise install node npm:corepack
ENV MISE_AUTO_INSTALL=false
RUN mise exec -- corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY --from=manifests /manifests/ ./
RUN mise exec -- yarn install --immutable
COPY . .
RUN mise exec -- yarn build

FROM node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4
WORKDIR /app
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness \
    && mkdir -p /data \
    && chown -R 10001:10001 /data
COPY --from=build --chown=10001:10001 /app/ ./
USER 10001
EXPOSE 3333
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "test/fixtures/sample-mcp-server/server.ts"]
