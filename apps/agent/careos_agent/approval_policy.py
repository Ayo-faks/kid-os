"""Phase 3 §4 — shared approval policy reader for Hermes skills.

Loads ``packages/contracts/approval-policy.yaml`` (the same file the
@careos/contracts TypeScript reader parses) and exposes the effective
approval level for a given skill + context. The cross-language consistency
contract is asserted by ``tests/test_approval_policy.py`` on the agent side
and ``approval-policy.test.ts`` on the contracts side.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

import yaml

APPROVAL_LEVELS: tuple[str, ...] = ("none", "confirm", "dual_sign_off")
APPROVAL_ROLES: tuple[str, ...] = ("manager", "safeguarding_lead")


@dataclass(frozen=True)
class ConditionalRule:
    when: Mapping[str, Any]
    level: str
    required_roles: tuple[str, ...]


@dataclass(frozen=True)
class SkillPolicy:
    level: str
    description: str
    required_roles: tuple[str, ...]
    conditional: tuple[ConditionalRule, ...] = ()


@dataclass(frozen=True)
class ApprovalRequirement:
    level: str
    required_roles: tuple[str, ...]
    signatures_required: int


@dataclass(frozen=True)
class ApprovalPolicy:
    version: int
    skills: Mapping[str, SkillPolicy]


def _resolve_default_path() -> Path:
    override = os.environ.get("CAREOS_APPROVAL_POLICY_PATH")
    if override:
        return Path(override)
    # apps/agent/careos_agent/approval_policy.py -> repo/packages/contracts/...
    here = Path(__file__).resolve()
    repo_root = here.parents[3]
    return repo_root / "packages" / "contracts" / "approval-policy.yaml"


def _parse(raw: Any) -> ApprovalPolicy:
    if not isinstance(raw, dict):
        raise ValueError("approval-policy.yaml must be a mapping")
    version = raw.get("version")
    if version != 1:
        raise ValueError(f"unsupported approval-policy version: {version!r}")
    skills_raw = raw.get("skills")
    if not isinstance(skills_raw, dict) or not skills_raw:
        raise ValueError("approval-policy.yaml must define a non-empty `skills` map")
    skills: dict[str, SkillPolicy] = {}
    for name, entry in skills_raw.items():
        if not isinstance(entry, dict):
            raise ValueError(f"skill {name!r} must be a mapping")
        level = entry.get("level")
        if level not in APPROVAL_LEVELS:
            raise ValueError(f"skill {name!r} has invalid level {level!r}")
        description = entry.get("description")
        if not isinstance(description, str) or not description:
            raise ValueError(f"skill {name!r} requires a non-empty description")
        required_roles = _parse_required_roles(name, entry.get("required_roles"), level)
        conditional_raw = entry.get("conditional") or []
        if not isinstance(conditional_raw, list):
            raise ValueError(f"skill {name!r} conditional must be a list")
        conditional: list[ConditionalRule] = []
        for rule in conditional_raw:
            if not isinstance(rule, dict):
                raise ValueError(f"skill {name!r} conditional rule must be a mapping")
            when = rule.get("when")
            rule_level = rule.get("level")
            if not isinstance(when, dict) or not when:
                raise ValueError(f"skill {name!r} conditional rule needs a non-empty `when`")
            if rule_level not in APPROVAL_LEVELS:
                raise ValueError(
                    f"skill {name!r} conditional rule has invalid level {rule_level!r}"
                )
            rule_roles = _parse_required_roles(name, rule.get("required_roles"), rule_level)
            conditional.append(
                ConditionalRule(
                    when=dict(when),
                    level=rule_level,
                    required_roles=rule_roles,
                )
            )
        skills[name] = SkillPolicy(
            level=level,
            description=description,
            required_roles=required_roles,
            conditional=tuple(conditional),
        )
    return ApprovalPolicy(version=version, skills=skills)


def _parse_required_roles(skill: str, raw: Any, level: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or any(role not in APPROVAL_ROLES for role in raw):
        raise ValueError(f"skill {skill!r} has invalid required_roles {raw!r}")
    roles = tuple(raw)
    expected = {"none": 0, "confirm": 1, "dual_sign_off": 2}[level]
    if len(roles) != expected or len(set(roles)) != len(roles):
        raise ValueError(
            f"skill {skill!r} level {level!r} requires {expected} distinct role(s)"
        )
    return roles


@lru_cache(maxsize=8)
def load_approval_policy(path: str | None = None) -> ApprovalPolicy:
    resolved = Path(path) if path else _resolve_default_path()
    with resolved.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)
    return _parse(raw)


def get_skill_policy(skill: str, policy: ApprovalPolicy | None = None) -> SkillPolicy:
    resolved = policy or load_approval_policy()
    entry = resolved.skills.get(skill)
    if entry is None:
        raise KeyError(f"Unknown skill in approval policy: {skill}")
    return entry


def resolve_approval_level(
    skill: str,
    context: Mapping[str, Any] | None = None,
    policy: ApprovalPolicy | None = None,
) -> str:
    entry = get_skill_policy(skill, policy)
    ctx = context or {}
    for rule in entry.conditional:
        if all(ctx.get(key) == value for key, value in rule.when.items()):
            return rule.level
    return entry.level


def resolve_approval_requirement(
    skill: str,
    context: Mapping[str, Any] | None = None,
    policy: ApprovalPolicy | None = None,
) -> ApprovalRequirement:
    entry = get_skill_policy(skill, policy)
    ctx = context or {}
    for rule in entry.conditional:
        if all(ctx.get(key) == value for key, value in rule.when.items()):
            return ApprovalRequirement(
                level=rule.level,
                required_roles=rule.required_roles,
                signatures_required=len(rule.required_roles),
            )
    return ApprovalRequirement(
        level=entry.level,
        required_roles=entry.required_roles,
        signatures_required=len(entry.required_roles),
    )
