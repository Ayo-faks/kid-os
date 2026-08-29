# Governance

Kid-OS uses a maintainer-led governance model during pre-release development.
Maintainers are listed in [MAINTAINERS.md](MAINTAINERS.md).

## Decisions

Routine changes are decided through pull-request review. Changes to architecture,
security boundaries, data isolation, audit behavior, workflow ownership,
compatibility, licensing, or governance require an issue or design record before
implementation and approval from the relevant code owners.

When consensus is not possible, maintainers document the decision and its
tradeoffs. Security embargo decisions may remain private until coordinated
disclosure.

## Maintainers

New maintainers are selected based on sustained, constructive contributions,
sound judgment in the project's high-sensitivity domain, and demonstrated care
for security and community standards. Existing maintainers approve additions and
removals and record them in `MAINTAINERS.md`.

Maintainers must disclose conflicts of interest and recuse themselves when their
impartiality could reasonably be questioned.

## Releases

Source releases require green public quality gates and a signed tag. Access to
the public repository does not grant access to any private deployment, secret,
environment, production system, or release evidence store.

This model may be revised as the contributor and maintainer community grows.
