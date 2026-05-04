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
from .models import AttributeDefinition, LabelDefinition, Project, User


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
STARTER_LABELS: list[tuple[str, str, str, str | None]] = [
    # Top-level groupings
    ("Document Structure", "#0f172a", "Structural elements of the prospectus.", None),
    ("MREL Eligibility", "#dc2626", "Labels driving MREL eligibility analysis.", None),
    ("Governing Law", "#475569", "Choice of law and submission to jurisdiction.", None),

    # Document Structure children
    ("Section Heading", "#1e293b", "Top-level section heading (e.g. 'TERMS AND CONDITIONS OF THE SUBORDINATED NOTES').", "Document Structure"),
    ("Definition", "#7c3aed", "A defined term and its definition.", "Document Structure"),
    ("Condition", "#1d4ed8", "A numbered/lettered condition within a Terms & Conditions section.", "Document Structure"),

    # MREL Eligibility children
    ("Subordination Clause", "#b45309", "Clause governing ranking/subordination of the Notes.", "MREL Eligibility"),
    ("Loss Absorption / Bail-in", "#ea580c", "Statutory loss absorption, write-down, or conversion language.", "MREL Eligibility"),
    ("Acceleration / Default", "#16a34a", "Events of default and noteholder acceleration rights.", "MREL Eligibility"),
    ("Maturity / Redemption", "#0d9488", "Stated maturity, optional redemption, regulatory call clauses.", "MREL Eligibility"),
    ("MREL-Eligible (positive)", "#15803d", "Clause that contributes positively to MREL eligibility.", "MREL Eligibility"),
    ("MREL-Disqualifying", "#991b1b", "Clause whose presence disqualifies the instrument from MREL eligibility.", "MREL Eligibility"),
]


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
    for name, color, desc, parent_name in STARTER_LABELS:
        if name in by_name:
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