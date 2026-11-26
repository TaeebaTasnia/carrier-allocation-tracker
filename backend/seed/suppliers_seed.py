SEED_SUPPLIERS = [
    ("77523", "Comfit Composite Knit Ltd", "COMCOMDAC"),
    ("77534", "Norban Comptex Ltd.", "NORCOMDAC"),
    ("77539", "Fakir Apparels Ltd", "FAKAPPNAR"),
    ("77566", "Epyllion Knitwears Ltd", "EPYKNIDAC"),
    ("77572", "ISLAM GARMENTS LTD. (UNIT-2)", "ISLGARGAZ"),
    ("77580", "MIDLAND KNITWEAR LTD", "MIDKNINAR"),
    ("84771", "FAKIR FASHION LTD.", "FAKFASDAC"),
    ("84802", "A-ONE POLAR LTD", "AONEPONAR"),
    ("84803", "Tasniah Fabrics Ltd.", "TASFABGAZ"),
    ("84827", "Jay Jay Mills (Bangladesh) Private Limited", "JAYJAYCGP"),
    ("84833", "Flamingo Fashions Ltd", "FLAFASGAZ"),
    ("84854", "Divine Intimates Ltd.", "DIVINTCGP"),
    ("77591", "Pacific Blue (Jeans Wear) Ltd", "PACBLUSAV"),
    ("84894", "Friends Knittings Ltd.", "FRIKNIGAZ"),
]


def seed_suppliers(db) -> int:
    """Insert the supplier list (updated 2026-11-26: 14 suppliers) if the table is empty."""
    from app.models import Supplier
    if db.query(Supplier).count():
        return 0
    for code, name, cw in SEED_SUPPLIERS:
        db.add(Supplier(code=code, name=name, cw_code=cw))
    db.commit()
    return len(SEED_SUPPLIERS)
