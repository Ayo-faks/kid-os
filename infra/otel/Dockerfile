FROM otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6

COPY --chown=10001:10001 --chmod=0444 otel-collector.azure.yaml /etc/otelcol-contrib/config.yaml

USER 10001:10001