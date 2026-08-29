## Summary

Describe the problem, the chosen change, and its observable effect.

## Validation

List the exact checks run and their results.

## Safety Checklist

- [ ] I used only synthetic data and included no real safeguarding, personal, credential, log, trace, export, or database data.
- [ ] I added or updated tests for changed behavior.
- [ ] I preserved transaction-local tenant/home context and did not weaken RLS.
- [ ] I did not update or delete rows from `audit.events`.
- [ ] I did not add direct model-provider egress outside `llm-gateway`.
- [ ] I considered authentication, authorization, idempotency, retention, accessibility, and failure states.
- [ ] I documented configuration, API, schema, queue, workflow, or compatibility changes.
- [ ] I ran the relevant format, lint, typecheck, test, build, and integration checks.
- [ ] Every commit includes a DCO `Signed-off-by` trailer.

## Compatibility

Describe migrations, legacy aliases, rollout order, and rollback. Write `None`
when the change has no compatibility impact.
