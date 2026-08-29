FROM golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc AS k6

ARG K6_VERSION=v2.1.0
ARG K6_SUM=h1:tMdUG9z0aBIL1eWIWlvSXke4rh0yA2x2KsilF0FycJI=
ARG K6_GO_MOD_SUM=h1:0xhbdfFEdP7WM7YE7/QeL8seWC4l1kVEFsCD1J6mPPU=

WORKDIR /src

RUN module_json="$(go mod download -json "go.k6.io/k6/v2@$K6_VERSION")" \
    && printf '%s\n' "$module_json" | grep -Fq "\"Sum\": \"$K6_SUM\"" \
    && printf '%s\n' "$module_json" | grep -Fq "\"GoModSum\": \"$K6_GO_MOD_SUM\"" \
    && cp -a "$(go env GOMODCACHE)/go.k6.io/k6/v2@$K6_VERSION/." . \
    && chmod -R u+w . \
    && go mod edit -require=google.golang.org/grpc@v1.82.1 \
    && go mod edit -require=golang.org/x/text@v0.39.0 \
    && CGO_ENABLED=0 go build -mod=mod -trimpath -o /out/k6 . \
    && go version -m /out/k6 | awk '$1 == "dep" && $2 == "google.golang.org/grpc" && $3 == "v1.82.1" { grpc = 1 } $1 == "dep" && $2 == "golang.org/x/text" && $3 == "v0.39.0" { text = 1 } END { exit !(grpc && text) }'

FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build

ARG DEBIAN_SNAPSHOT=20260811T000000Z

ENV DEBIAN_FRONTEND=noninteractive \
    HUSKY=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace

RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
    && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
    && rm -f packages/contracts/tsconfig.tsbuildinfo packages/object-storage/tsconfig.tsbuildinfo packages/schemas/tsconfig.tsbuildinfo \
    && pnpm --filter @careos/contracts build \
    && pnpm --filter @careos/schemas build \
    && pnpm --filter @careos/object-storage build \
    && node scripts/prepare-container-workspace-packages.mjs \
        && DATABASE_URL=postgresql://careos_app:change-me@postgres:5432/careos?schema=public \
            pnpm --filter @careos/api exec prisma generate --schema prisma/schema.prisma \
        && pnpm --filter @careos/e2e exec playwright install chromium \
        && prisma_client="$(find node_modules/.pnpm -path '*/node_modules/.prisma/client' -type d -print -quit)" \
        && test -n "$prisma_client" \
        && cp -a "$prisma_client" /tmp/prisma-client \
        && rm -rf node_modules apps/*/node_modules apps/web/e2e/node_modules \
            packages/*/node_modules infra/validation/node_modules \
        && pnpm install --frozen-lockfile --prod --ignore-scripts --shamefully-hoist \
            --filter @careos/validation-runner... \
            --filter @careos/api... \
            --filter @careos/worker... \
        && prisma_package="$(find node_modules/.pnpm -path '*/node_modules/@prisma/client' -type d -print -quit)" \
        && test -n "$prisma_package" \
        && prisma_node_modules="$(dirname "$(dirname "$prisma_package")")" \
        && mkdir -p "$prisma_node_modules/.prisma" \
        && cp -a /tmp/prisma-client "$prisma_node_modules/.prisma/client" \
        && rm -rf /tmp/prisma-client

FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime

ARG DEBIAN_SNAPSHOT=20260811T000000Z

ENV DEBIAN_FRONTEND=noninteractive \
    HUSKY=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /workspace

COPY --from=build --chown=node:node /workspace /workspace
COPY --from=build --chown=node:node /ms-playwright /ms-playwright
COPY --from=k6 --chmod=0755 /out/k6 /usr/local/bin/k6

RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
    && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl dnsutils jq openssl postgresql-client \
    && node_modules/.bin/playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache /pnpm /usr/local/lib/node_modules \
    && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

USER node

CMD ["bash"]