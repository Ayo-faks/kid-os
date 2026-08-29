# Contributing to Kid-OS

Kid-OS handles workflows that may involve highly sensitive safeguarding data.
Contributions are welcome, but safety, tenant isolation, auditability, and clear
operational boundaries take precedence over speed.

## Before You Start

- Use only synthetic data in source, tests, screenshots, issues, and pull
  requests. Never submit real child, resident, staff, home, or incident data.
- Report security vulnerabilities privately as described in
  [SECURITY.md](SECURITY.md).
- Discuss architecture changes in an issue before implementation. The locked
  decisions and safety invariants are documented in [docs/plan.md](docs/plan.md).

## Development Setup

Prerequisites are Node 24 or later, pnpm 10 or later, Docker with Compose v2,
and Python 3.11 or later for the agent tests.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:agent
```

Run `scripts/compose-smoke.sh` when a change affects service integration,
database bootstrap, authentication, or container configuration.

## Pull Requests

1. Keep each pull request focused on one logical change.
2. Add or update tests for changed behavior.
3. Preserve TypeScript strict mode. Do not introduce `any` without the
   repository-required disable comment and a one-line reason.
4. Preserve transaction-local tenant and home context for every database path.
5. Never update or delete `audit.events` rows.
6. Route model-provider egress through `llm-gateway`; do not add provider SDK
   calls to application or agent code.
7. Update documentation when behavior, configuration, or compatibility changes.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## Developer Certificate of Origin

Every commit must include a `Signed-off-by` trailer certifying the
[Developer Certificate of Origin](DCO):

```bash
git commit -s -m "feat: describe the change"
```

The sign-off uses your real name and an email address you are willing to include
in the permanent public Git history. It is not a GPG signature.

## Licensing

Unless explicitly stated otherwise, contributions intentionally submitted to
Kid-OS are licensed under the [Apache License 2.0](LICENSE).
