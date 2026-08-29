FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build

ARG DEBIAN_SNAPSHOT=20260811T000000Z

ENV HUSKY=0 \
    DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace

RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
  && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json tsconfig.json ./
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/object-storage/package.json packages/object-storage/package.json
COPY apps/llm-gateway/package.json apps/llm-gateway/package.json

RUN pnpm install --frozen-lockfile

COPY packages/tsconfig packages/tsconfig
COPY apps/llm-gateway apps/llm-gateway

RUN rm -f apps/llm-gateway/tsconfig.tsbuildinfo \
  && pnpm --filter @careos/llm-gateway build \
  && pnpm --filter @careos/llm-gateway deploy --legacy --prod /runtime \
  && cp -a apps/llm-gateway/dist /runtime/dist

FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime

ARG DEBIAN_SNAPSHOT=20260811T000000Z

ENV DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
  && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
  /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production

WORKDIR /workspace/apps/llm-gateway

COPY --from=build --chown=node:node /runtime ./

USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]