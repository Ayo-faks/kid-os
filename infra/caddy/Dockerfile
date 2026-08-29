FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc AS builder

ARG TARGETARCH
ARG TARGETOS

RUN go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.5

RUN CGO_ENABLED=0 GOARCH=$TARGETARCH GOOS=$TARGETOS \
	/go/bin/xcaddy build v2.11.4 \
		--replace google.golang.org/grpc=google.golang.org/grpc@v1.82.1 \
		--replace golang.org/x/text=golang.org/x/text@v0.39.0 \
		--output /usr/bin/caddy \
	&& go version -m /usr/bin/caddy | awk '$1 == "=>" && $2 == "golang.org/x/text" && $3 == "v0.39.0" { found = 1 } END { exit !found }'

FROM docker.io/library/alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

RUN apk upgrade --no-cache \
	&& addgroup -S caddy \
	&& adduser -S -D -G caddy caddy \
	&& mkdir -p /config /data /etc/caddy \
	&& chown -R caddy:caddy /home/caddy /config /data /etc/caddy

ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data

COPY --from=builder --chmod=0755 /usr/bin/caddy /usr/bin/caddy
COPY --chown=caddy:caddy --chmod=0444 Caddyfile.azure /etc/caddy/Caddyfile

USER caddy

ENTRYPOINT ["/usr/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]