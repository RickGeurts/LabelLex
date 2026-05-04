"""One-shot seed: default user, project, and starter label hierarchy.

The label tree below is a starter taxonomy for MREL analysis on bank
prospectuses. It's not authoritative — admins can edit, rename, or replace
it via the UI/API. Two top-level groupings:

- "Document Structure" — categorical labels for navigating the prospectus
  (headings, defined terms, individual conditions).
- "MREL Eligibility" — the labels that actually drive eligibility analysis.

We keep "Governing Law" top-level for now because it's neither a structural
nor an MREL label.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import (
    AttributeDefinition,
    LabelDefinition,
    Project,
    RelationDefinition,
    User,
)


# (label_name, attr_name, value_type, enum_values, required, description)
STARTER_ATTRIBUTES: list[tuple[str, str, str, list[str] | None, bool, str | None]] = [
    # Inherited by every MREL Eligibility leaf:
    ("MREL Eligibility", "currency", "string", None, False, "Currency of denomination (e.g. EUR, USD)."),
    # Subordination
    (
        "Subordination Clause", "ranking", "enum",
        ["senior_preferred", "senior_non_preferred", "subordinated"], True,
        "Position in the resolution waterfall.",
    ),
    # Maturity / Redemption
    ("Maturity / Redemption", "stated_maturity_date", "date", None, False, "Stated maturity date if specified."),
    ("Maturity / Redemption", "has_issuer_call", "bool", None, False, "Issuer redemption right at the issuer's option."),
    ("Maturity / Redemption", "min_remaining_maturity_years", "number", None, False, "Minimum remaining maturity (years) for MREL eligibility."),
    # Acceleration / Default
    (
        "Acceleration / Default", "noteholder_can_accelerate", "bool", None, True,
        "Whether noteholders have a contractual right to accelerate.",
    ),
    # Loss Absorption / Bail-in
    (
        "Loss Absorption / Bail-in", "mechanism", "enum",
        ["statutory_only", "contractual_recognition", "mixed"], False,
        "How loss absorption / bail-in is achieved.",
    ),
]


# (name, color, description, parent_name | None)
#
# Descriptions are deliberately rich because they're consumed verbatim by
# the clause-discovery model — concrete legal markers and explicit
# negatives ("do NOT match …") move zero-shot precision more than any
# system-prompt change.
STARTER_LABELS: list[tuple[str, str, str, str | None]] = [
    # Top-level groupings
    ("Document Structure", "#0f172a", "Structural elements of the prospectus.", None),
    ("MREL Eligibility", "#dc2626", "Labels driving MREL eligibility analysis.", None),
    ("Governing Law", "#475569", "Choice-of-law clause naming the governing law of the Notes (typically English or Dutch). Skip generic submission-to-jurisdiction boilerplate unless it is the operative governing-law clause.", None),

    # Document Structure children
    ("Section Heading", "#1e293b", "Top-level section heading in ALL CAPS or Title Case (e.g. 'TERMS AND CONDITIONS OF THE SUBORDINATED NOTES'). Used for navigation, never for MREL analysis.", "Document Structure"),
    (
        "Definition",
        "#7c3aed",
        "A defined term followed by its definition (typical pattern: '\"Term\" means …' or '\"Term\" has the meaning ascribed to it in …'). Useful for navigating the document but rarely the substantive clause we want for MREL analysis — the operative clauses that USE those terms are what matter.",
        "Document Structure",
    ),
    (
        "Condition",
        "#1d4ed8",
        "A numbered or lettered Condition within a Terms & Conditions section (e.g. 'Condition 3 (Status)', 'Condition 6(i) Statutory Loss Absorption'). Tag the full Condition body, not just the heading.",
        "Document Structure",
    ),

    # MREL Eligibility children
    (
        "Subordination Clause",
        "#b45309",
        "Clause stating where the Notes rank in the issuer's resolution waterfall. Look for explicit ranking language: 'rank pari passu' (equal ranking), 'subordinated to senior unsecured creditors', 'rank junior to', 'rank senior to ordinary shares', references to Article 108 BRRD, 'Senior Non-Preferred', or Tier 2 instruments. Do NOT match generic 'subordinated to all subordinated obligations of the Issuer' boilerplate without an actual ranking statement.",
        "MREL Eligibility",
    ),
    (
        "Loss Absorption / Bail-in",
        "#ea580c",
        "Clause acknowledging or implementing statutory loss absorption: bail-in by the resolution authority, contractual recognition under Article 55 BRRD, permanent write-down, conversion to equity, or any reference to the Single Resolution Board / De Nederlandsche Bank / national resolution authority exercising resolution powers. Common phrasing: 'Statutory Loss Absorption', 'Bail-in Power', 'permanent write-down', 'conversion into ordinary shares of the Issuer'. Skip Risk Factor language that just describes the general risk of loss absorption.",
        "MREL Eligibility",
    ),
    (
        "Acceleration / Default",
        "#16a34a",
        "Clause defining (or limiting) noteholders' right to accelerate the Notes upon an Event of Default. Look for 'Event of Default', 'declare the Notes immediately due and payable', 'accelerate the Notes' — and, for MREL-eligible Notes, explicit limitations like 'no right of acceleration except in the event of insolvency / non-payment of principal at maturity'. Both substantive triggers AND explicit limitations are interesting; tag whichever is present.",
        "MREL Eligibility",
    ),
    (
        "Maturity / Redemption",
        "#0d9488",
        "Clause about when and how the Notes mature or may be redeemed: stated maturity date, scheduled maturity, optional redemption at the issuer's option ('Issuer Call'), regulatory call (redemption upon a regulatory event affecting MREL/TLAC eligibility), tax call, clean-up call. Skip generic Risk Factor discussion of redemption risk.",
        "MREL Eligibility",
    ),
    (
        "MREL-Eligible (positive)",
        "#15803d",
        "Substantive clause that contributes to or affirms MREL eligibility under Article 72b CRR / Article 45f BRRD: structural subordination, no-acceleration-except-in-insolvency, contractual bail-in recognition, ≥ 1-year remaining maturity, no set-off, no security/collateralisation. Tag the operative clause that does the work, not its heading. Prefer a more specific label (e.g. 'Subordination Clause') if applicable.",
        "MREL Eligibility",
    ),
    (
        "MREL-Disqualifying",
        "#991b1b",
        "Clause whose presence disqualifies the instrument from MREL eligibility: noteholder put options, set-off rights, security/collateralisation of the Notes, acceleration on contractual breaches other than insolvency / non-payment of principal at maturity, indemnities owed to noteholders, or any feature that would let noteholders extract value ahead of resolution.",
        "MREL Eligibility",
    ),
]


# (name, color, description)
STARTER_RELATION_DEFS: list[tuple[str, str, str]] = [
    (
        "modifies",
        "#7c3aed",
        "Source clause modifies the meaning or scope of the target clause "
        "(e.g. Condition 6 'Statutory Loss Absorption' modifies the default "
        "ranking set out in Condition 3 'Status').",
    ),
    (
        "cross-references",
        "#0ea5e9",
        "Source clause cites or refers back to the target clause "
        "(e.g. 'subject to Condition 6(i) above', 'as defined in Condition 1').",
    ),
    (
        "subordinates-to",
        "#b45309",
        "Source instrument/clause is subordinated to the target — "
        "useful for capturing the resolution waterfall across multiple "
        "tranches in the same prospectus.",
    ),
]


# Original v0 descriptions — used by the seed upgrader to refresh labels in
# the default project that haven't been edited. We only overwrite when the
# stored description matches one of these literals exactly, so any user
# edit (even a typo fix) is preserved.
_V0_DESCRIPTIONS: dict[str, str] = {
    "Section Heading": "Top-level section heading (e.g. 'TERMS AND CONDITIONS OF THE SUBORDINATED NOTES').",
    "Definition": "A defined term and its definition.",
    "Condition": "A numbered/lettered condition within a Terms & Conditions section.",
    "Subordination Clause": "Clause governing ranking/subordination of the Notes.",
    "Loss Absorption / Bail-in": "Statutory loss absorption, write-down, or conversion language.",
    "Acceleration / Default": "Events of default and noteholder acceleration rights.",
    "Maturity / Redemption": "Stated maturity, optional redemption, regulatory call clauses.",
    "MREL-Eligible (positive)": "Clause that contributes positively to MREL eligibility.",
    "MREL-Disqualifying": "Clause whose presence disqualifies the instrument from MREL eligibility.",
    "Governing Law": "Choice of law and submission to jurisdiction.",
}


def seed(db: Session) -> None:
    """Idempotent — safe to call on every startup."""
    user = db.scalar(select(User).where(User.id == settings.default_user_id))
    if user is None:
        user = User(id=settings.default_user_id, email="rick@labellex.local", name="Rick")
        db.add(user)
        db.flush()

    project = db.scalar(select(Project).where(Project.id == settings.default_project_id))
    if project is None:
        project = Project(
            id=settings.default_project_id,
            name="MREL Prospectuses",
            owner_id=user.id,
        )
        db.add(project)
        db.flush()

    by_name: dict[str, LabelDefinition] = {l.name: l for l in project.labels}
    # Two-pass: create in order, resolving parent_name → id from previously-created rows.
    new_desc_by_name = {name: desc for name, _, desc, _ in STARTER_LABELS}
    for name, color, desc, parent_name in STARTER_LABELS:
        if name in by_name:
            # Description-only upgrade: if the stored description still matches
            # the v0 boilerplate exactly, replace it with the richer copy. Any
            # user edit (even a typo fix) deviates from the literal and is
            # preserved.
            existing = by_name[name]
            v0_desc = _V0_DESCRIPTIONS.get(name)
            if v0_desc is not None and existing.description == v0_desc:
                existing.description = new_desc_by_name[name]
            continue
        parent_id = by_name[parent_name].id if parent_name else None
        label = LabelDefinition(
            project_id=project.id,
            parent_id=parent_id,
            name=name,
            color=color,
            description=desc,
        )
        db.add(label)
        db.flush()
        by_name[name] = label

    # Relation definitions — idempotent create-if-missing.
    existing_rel_names = {
        rd.name
        for rd in db.scalars(
            select(RelationDefinition).where(
                RelationDefinition.project_id == project.id
            )
        ).all()
    }
    for rel_name, rel_color, rel_desc in STARTER_RELATION_DEFS:
        if rel_name in existing_rel_names:
            continue
        db.add(
            RelationDefinition(
                project_id=project.id,
                name=rel_name,
                color=rel_color,
                description=rel_desc,
            )
        )

    # Attributes — only seed if the label exists and doesn't already have the attribute.
    for label_name, attr_name, vtype, enum_values, required, attr_desc in STARTER_ATTRIBUTES:
        label = by_name.get(label_name)
        if label is None:
            continue
        existing = {a.name for a in label.attributes}
        if attr_name in existing:
            continue
        db.add(
            AttributeDefinition(
                label_id=label.id,
                name=attr_name,
                value_type=vtype,
                enum_values=enum_values,
                required=required,
                description=attr_desc,
            )
        )

    db.commit()