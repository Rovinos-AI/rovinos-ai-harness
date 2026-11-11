# SPDX-License-Identifier: Apache-2.0
# Collect every workspace manifest (paths preserved) so `yarn install --immutable` sees all workspaces the lockfile
# lists. Adding a package then needs no Dockerfile change. This layer only changes when a manifest changes.
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
ARG WITH_REDIS_RATE_LIMIT=0
RUN if [ "$WITH_REDIS_RATE_LIMIT" = "1" ]; then \
      mise exec -- yarn workspaces focus @rovinos/cli @rovinos/core @rovinos/store-sqlite @rovinos/rate-limit-redis --production; \
    else \
      mise exec -- yarn workspaces focus @rovinos/cli @rovinos/core @rovinos/store-sqlite --production; \
    fi \
    && mkdir -p /out/dist /out/packages \
    && cp -a node_modules /out/node_modules \
    && for package in packages/*/; do \
         if [ -d "${package}dist" ]; then \
           mkdir -p "/out/${package}" && cp -a "${package}package.json" "${package}dist" "/out/${package}"; \
         fi; \
       done \
    && cp -a packages/cli/dist /out/

FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS runtime-os-audit

# CVE-2026-76844 and CVE-2026-85091: the pinned node:26-slim digest still ships zlib1g 1.3.1-1+b1.
# Remove this upgrade once the upstream base image includes zlib1g 1.3.1-1+deb13u1 or later.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness \
    && mkdir -p /var/lib/harness/event-store /var/lib/harness/vault \
    && chown -R 10001:10001 /var/lib/harness /app

FROM runtime-os-audit AS runtime

RUN rm -rf /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-cdrom /usr/bin/apt-config \
      /usr/bin/dpkg* /usr/sbin/dpkg* /usr/lib/apt /usr/lib/dpkg \
      /var/lib/apt /var/lib/dpkg /var/cache/apt \
      /usr/share/doc/apt /usr/share/doc/dpkg /usr/share/man/man1/apt* \
      /usr/share/man/man8/apt* /usr/share/man/man1/dpkg* /usr/share/man/man8/dpkg* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
    && command -v node \
    && ! command -v apt-get \
    && ! command -v dpkg \
    && ! command -v npm \
    && ! command -v docker
COPY --from=build --chown=10001:10001 /out/ ./
USER 10001
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/Rovinos-AI/rovinos-ai-harness" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${REVISION}"
ENTRYPOINT ["node", "dist/bin.js"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "dist/bin.js", "--version"]
