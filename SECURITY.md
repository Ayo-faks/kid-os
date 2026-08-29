# Security Policy

Kid-OS is pre-release software for a high-sensitivity domain. Publishing the
source does not certify a deployment for UK GDPR, safeguarding, Ofsted, NHS,
medical, legal, or other regulatory requirements.

## Supported Versions

No stable release is currently supported. Security fixes are applied to the
default branch while the project is in pre-release development.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub
[private vulnerability reporting](https://github.com/Ayo-faks/kid-os/security/advisories/new)
and include:

- affected commit or version;
- impact and affected component;
- reproducible steps using synthetic data;
- any suggested mitigation; and
- whether the issue is already public or actively exploited.

Maintainers will respond on a best-effort basis, coordinate a fix and disclosure
window, and credit reporters who request attribution. Do not include secrets,
credentials, or real safeguarding data in the report.

## Data Safety

- Never test with real child, resident, staff, home, or incident data.
- Treat logs, screenshots, traces, database dumps, and exported bundles as
  potentially sensitive.
- Preserve PostgreSQL row-level security and transaction-local tenant/home GUCs.
- Preserve the append-only `audit.events` contract.
- Route all model-provider traffic through `llm-gateway` so privacy and budget
  controls remain at one boundary.

Operational incidents affecting a deployed fork remain the operator's
responsibility. The project does not monitor or administer downstream systems.
