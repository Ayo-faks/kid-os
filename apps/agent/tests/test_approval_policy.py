"""Phase 3 §4 — Python side of the shared approval policy contract."""

from __future__ import annotations

import unittest

from careos_agent.approval_policy import (
    APPROVAL_LEVELS,
    get_skill_policy,
    load_approval_policy,
    resolve_approval_level,
    resolve_approval_requirement,
)


class ApprovalPolicyTests(unittest.TestCase):
    def test_loads_with_version_one(self) -> None:
        policy = load_approval_policy()
        self.assertEqual(policy.version, 1)
        self.assertGreater(len(policy.skills), 0)

    def test_every_skill_uses_declared_levels(self) -> None:
        policy = load_approval_policy()
        for name, entry in policy.skills.items():
            self.assertIn(entry.level, APPROVAL_LEVELS, name)
            for rule in entry.conditional:
                self.assertIn(rule.level, APPROVAL_LEVELS, name)

    def test_known_skill_defaults_match_contract(self) -> None:
        expectations = {
            "ping": "none",
            "list_form_templates": "none",
            "narrate_rota": "none",
            "draft_incident_from_text": "confirm",
            "summarize_handover": "confirm",
            "draft_email": "none",
        }
        for skill, expected in expectations.items():
            self.assertEqual(get_skill_policy(skill).level, expected, skill)

    def test_draft_email_escalates_on_sensitivity(self) -> None:
        self.assertEqual(
            resolve_approval_level("draft_email", {"sensitivity": "sensitive"}),
            "dual_sign_off",
        )
        self.assertEqual(
            resolve_approval_level("draft_email", {"sensitivity": "routine"}),
            "none",
        )
        self.assertEqual(resolve_approval_level("draft_email"), "none")

    def test_role_requirements_match_typescript_contract(self) -> None:
        routine = resolve_approval_requirement("draft_incident_from_text")
        self.assertEqual(routine.required_roles, ("manager",))
        self.assertEqual(routine.signatures_required, 1)

        safeguarding = resolve_approval_requirement(
            "draft_incident_from_text", {"safeguarding": True}
        )
        self.assertEqual(
            safeguarding.required_roles,
            ("manager", "safeguarding_lead"),
        )
        self.assertEqual(safeguarding.signatures_required, 2)

    def test_unknown_skill_raises(self) -> None:
        with self.assertRaises(KeyError):
            get_skill_policy("does_not_exist")


if __name__ == "__main__":
    unittest.main()
