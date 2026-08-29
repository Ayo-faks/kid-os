# Third-Party Notices

**Review status: IN PROGRESS.** This is the initial distribution inventory, not
the final attribution record. Do not enable public visibility or redistribute a
bundled Kid-OS deployment until every entry has a verified license, required
notice text, source location, and redistribution assessment.

Kid-OS is licensed under Apache-2.0. Dependencies, container images, models, and
external services remain under their respective upstream terms.

## Application Dependencies

- JavaScript and TypeScript dependencies are locked in `pnpm-lock.yaml`.
- Python dependencies are declared in `apps/agent/pyproject.toml`.
- Release SBOMs are generated in SPDX JSON format by CI.

The final notice must be generated from the exact release lockfiles and reviewed
for dependencies whose licenses require attribution, notice preservation, source
offers, or other distribution obligations.

## Runtime Images

The authoritative image names and digests are recorded in
`infra/vendor-images.lock.json` and the project Dockerfiles. The current
distribution includes or references:

- Microsoft Durable Task Scheduler emulator
- Redis and pgvector/PostgreSQL
- Keycloak
- MinIO server and client
- Temporal server and UI
- Gotenberg and Docling Serve
- Novu and Mattermost Team Edition as optional services
- OpenTelemetry Collector
- Grafana, Loki, Tempo, and Prometheus
- Ollama
- Node.js, Python, Go, Alpine, Debian, Caddy, and installed Caddy modules used
  by project images

## Model Artifact

The default local model manifest is pinned in `infra/ollama-model.lock.json`.
Model weights and associated files are not licensed by the Kid-OS Apache-2.0
license. Their embedded or upstream model license must be reviewed separately
before redistribution.

## Release Requirement

Before changing the review status to `COMPLETE`, record for every distributed
artifact:

1. exact name, version, and digest;
2. upstream source and license URL;
3. SPDX license expression or documented exception;
4. required copyright and notice text;
5. source-code or written-offer obligations, if any; and
6. whether the artifact is bundled, downloaded at runtime, or optional.
