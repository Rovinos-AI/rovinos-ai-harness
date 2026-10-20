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
RUN mise exec -- yarn workspaces focus @harness/cli --production \
    && mkdir -p /out/dist /out/packages \
    && cp -a node_modules /out/node_modules \
    && for package in packages/*/; do \
         if [ -d "${package}dist" ]; then \
           mkdir -p "/out/${package}" && cp -a "${package}package.json" "${package}dist" "/out/${package}"; \
           if [ -d "${package}migrations" ]; then \
             cp -a "${package}migrations" "/out/${package}"; \
           fi; \
         fi; \
       done \
    && cp -a packages/cli/dist/. /out/dist/

FROM node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS runtime

WORKDIR /app
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness \
    && mkdir -p /var/lib/harness/event-store /var/lib/harness/vault \
    && chown -R 10001:10001 /var/lib/harness /app \
    && rm -rf /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-cdrom /usr/bin/apt-config \
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
