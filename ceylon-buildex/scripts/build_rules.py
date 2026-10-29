#!/usr/bin/env python3
"""Builds data/rules/far_rules.json - the FAR / zoning rules dataset.

Every number below was transcribed from documents read on 2026-10-19:

  * UDA Planning & Development Regulations 2021, Gazette Extraordinary 2235/54
    (8 Jul 2021), Schedule 6 - read through the Sri Jayawardenepura Kotte MC
    summary "PnBR_Schedules_2021_Summarized.pdf".
  * City of Colombo Development Plan (Amendment) 2008, Colombo MC copy
    (ccdp-2008.pdf), sections 4, 8 and Forms C1 / C2.
  * Gazette 2105/24 (9 Jan 2019) - amendments to the City of Colombo Development Plan.

The tables are plain data so they can be corrected or extended without touching
code: edit this file (or far_rules.json directly) and re-run the portal.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "rules" / "far_rules.json"

# ---------------------------------------------------------------- UDA 2021 Form A
# land-extent bands (m2), lower bound inclusive. Last band is "more than 4000".
EXTENT_BANDS = [150, 250, 375, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000]
ROAD_COLS = [6, 9, 12, 15]  # minimum road width (m); 15 means 15 m and above

# zone-factor band -> 12 rows (one per land-extent band) of 4 values (6/9/12/15+ m)
FORM_A_TEXT = {
    "0.50-0.74": """0.8 0.9 0.9 0.9
0.9 1 1.2 1.3
0.9 1 1.2 1.4
1 1.1 1.3 1.5
1 1.2 1.4 1.7
1.1 1.3 1.5 1.8
1.1 1.4 1.7 2
1.2 1.5 1.8 2.1
1.2 1.6 2 2.4
1.3 1.7 2.1 2.5
1.4 1.8 2.2 2.6
1.5 1.9 2.3 2.8""",
    "0.75-0.99": """1.3 1.3 1.4 1.4
1.3 1.6 1.8 2
1.3 1.6 1.9 2.1
1.4 1.7 2 2.2
1.5 1.8 2.2 2.5
1.6 1.9 2.3 2.7
1.7 2.1 2.5 3
1.8 2.3 2.7 3.1
1.9 2.4 3 3.6
2 2.5 3.1 3.7
2.2 2.6 3.3 3.9
2.5 2.8 3.5 4""",
    "1.00-1.24": """1.6 1.7 1.8 1.9
1.8 2.2 2.4 2.7
1.9 2.2 2.5 2.8
2 2.3 2.7 3
2.1 2.4 2.9 3.3
2.2 2.5 3 3.6
2.3 2.7 3.4 4
2.4 2.8 3.5 4.2
2.5 3.2 4 4.7
2.6 3.4 4.2 5
2.8 3.6 4.3 5.3
3 3.8 4.5 5.5""",
    "1.25-1.49": """2 2.2 2.3 2.4
2.2 2.7 3 3.3
2.3 2.8 3.2 3.4
2.4 3 3.4 3.5
2.6 3 3.6 4
2.7 3.1 3.8 4.5
2.9 3.4 4.2 5
3 3.5 4.4 5.4
3.1 3.8 4.7 5.8
3.2 4 5 6.2
3.3 4.3 5.5 6.6
3.5 4.5 6 7""",
    "1.50-1.74": """2.4 2.6 2.7 2.8
2.6 3.2 3.6 4
2.7 3.3 3.8 4.2
2.8 3.4 4 4.5
3.1 3.6 4.3 5
3.2 3.8 4.6 5.5
3.4 4 5 6
3.5 4.2 5.2 6.5
3.6 4.4 5.5 7
3.7 4.6 6 7.5
3.8 4.8 6.3 7.7
4 5 6.5 8""",
    "1.75-1.99": """2.8 3 3.2 3.3
3 3.4 4.3 4.7
3.2 3.5 4.5 5
3.4 3.6 4.7 5.5
3.5 3.8 5.1 6
3.6 4 5.4 6.5
3.7 4.2 5.8 7
3.8 4.4 6.2 7.5
3.9 4.6 6.5 8
4 4.8 6.9 8.5
4 5 7.3 9
4 5.2 7.5 9.5""",
    "2.00-2.24": """3 3.4 3.6 3.8
3.2 3.6 4.5 4.5
3.4 3.7 4.8 5.2
3.5 4 5 6
3.6 4.5 5.7 6.5
3.7 5 6.1 8
3.8 5.1 6.7 9
3.9 5.2 7.1 10
4 5.3 7.4 10.5
4 5.4 7.6 11
4 5.5 7.8 11.5
4 5.6 8 12""",
    "2.25-2.49": """3 3.4 3.6 4
3.5 3.8 4.5 5
3.6 4.5 4.7 5.5
3.7 5 5 6
3.8 5.1 6 6.5
3.9 5.3 6.5 8.5
4 5.4 7 10
4 5.5 7.5 10.5
4 5.6 7.5 11
4 5.7 8 11.5
4 5.8 8 12
4 5.9 8 UL""",
    "2.50-2.74": """3 3.4 3.6 4
3.5 4 5 5.5
3.6 4.6 5.2 6
3.7 5.1 5.5 6.5
3.8 5.2 6.5 7
3.9 5.4 7 9
4 5.5 7.5 10.5
4 5.6 7.5 11
4 5.7 8 11.5
4 5.8 8 12
4 5.9 8 12
4 6 8 UL""",
    "2.75-2.99": """3 3.4 3.6 4
3.5 4.2 5 5.5
3.6 4.7 5.2 6
3.7 5.2 5.5 6.5
3.8 5.3 7 7.5
3.9 5.5 7.5 9
4 5.6 7.5 10.5
4 5.7 8 11
4 5.8 8 11.5
4 5.9 8 12
4 6 8 12
4 6 8 UL""",
    "3.00-3.24": """3 3.4 3.6 4
3.5 4.4 5 5.5
3.6 4.8 5.2 6
3.7 5.3 5.5 6.5
3.8 5.4 7 7.5
3.9 5.6 7.5 9
4 5.7 8 10.5
4 5.8 8 11
4 5.9 8 11.5
4 6 8 12
4 6 8 12
4 6 8 UL""",
    "3.25-3.49": """3 3.4 3.6 4
3.5 4.6 5 5.5
3.6 4.9 5.2 6
3.8 5.4 5.5 6.5
4 5.5 7.5 8
4 5.7 8 9
4 5.8 8 11
4 5.9 8 11.5
4 6 8 12
4 6 8 12
4 6 8 12
4 6 8 UL""",
    "3.50-3.74": """3 3.4 3.6 4
3.5 4.8 5 5.5
3.6 5 5.2 6
3.8 5.5 5.5 6.5
4 5.6 7.5 8
4.2 5.8 8 9
4.2 6 8 11
4.2 6.2 8 11.5
4.2 6.4 8 12
4.2 6.5 8 12
4.2 6.5 8 12
4.2 6.5 8 UL""",
    "3.75-4.00": """3 3.4 3.6 4
3.5 5 5 5.5
3.6 5.4 5.2 6
4 5.7 5.5 6.5
4.5 6 7.5 8
4.5 6.5 8 9
4.5 7 8 11
4.5 7 8 12
4.5 7 8 12
4.5 7 8 12
4.5 7 8 12
4.5 7 8 UL""",
}


def parse_grid(txt):
    rows = []
    for line in txt.strip().splitlines():
        vals = []
        for tok in line.split():
            vals.append("UL" if tok == "UL" else float(tok))
        assert len(vals) == 4, line
        rows.append(vals)
    assert len(rows) == 12, len(rows)
    return rows


form_a = {band: parse_grid(txt) for band, txt in FORM_A_TEXT.items()}
assert len(form_a) == 14

# ---------------------------------------------------------------- UDA 2021 Form B / D / E
form_b_floors = {
    # zone-factor band group -> {road width (m): floors incl. ground}
    "0.50-0.74": {"3.0": 1, "4.5": 1},
    "0.75-1.24": {"3.0": 2, "4.5": 2},
    "1.25-3.49": {"3.0": 3, "4.5": 3},
    "3.50-4.00": {"3.0": 3, "4.5": 4},
}
form_d_floors = {"low": 1, "medium": 2, "high": 3}

# Form E: height category -> plot coverage and open space. The summary prints rear and side
# space twice - "without NLV / with NLV" (NLV = natural light and ventilation from that side).
# One tool read of the summary flagged the column alignment as not fully clean, so both
# columns are stored exactly as printed and shown to the user as such.
form_e = [
    {"category": "Low rise", "height_m": [0, 7], "min_frontage_m": 6,
     "coverage_nonres_pct": 80, "coverage_res_pct": 65,
     "rear_m": {"no_nlv": 2.3, "nlv": 2.3}, "side_m": {"no_nlv": None, "nlv": 2.3},
     "note": "80% applies only if the whole development is non-residential"},
    {"category": "Low rise", "height_m": [7, 15], "min_frontage_m": 6,
     "coverage_nonres_pct": 65, "coverage_res_pct": 65,
     "rear_m": {"no_nlv": 3.0, "nlv": 3.0}, "side_m": {"no_nlv": None, "nlv": 3.0}},
    {"category": "Intermediate rise", "height_m": [15, 30], "min_frontage_m": 12,
     "coverage_nonres_pct": 65, "coverage_res_pct": 65,
     "rear_m": {"no_nlv": 4.0, "nlv": 4.0}, "side_m": {"no_nlv": "1.0 and 3.0", "nlv": 4.0}},
    {"category": "Middle rise", "height_m": [30, 50], "min_frontage_m": 20,
     "coverage_nonres_pct": 65, "coverage_res_pct": 65,
     "rear_m": {"no_nlv": 4.0, "nlv": 5.0}, "side_m": {"no_nlv": 3.0, "nlv": 5.0}},
    {"category": "High rise", "height_m": [50, 75], "min_frontage_m": 30,
     "coverage_nonres_pct": 50, "coverage_res_pct": 50,
     "rear_m": {"no_nlv": 5.0, "nlv": 6.0}, "side_m": {"no_nlv": 4.0, "nlv": 6.0},
     "note": "65% is allowed for the podium only, up to 20% of tower height or 12 floors, whichever is less"},
    {"category": "Very high rise", "height_m": [75, None], "min_frontage_m": None,
     "coverage_nonres_pct": 50, "coverage_res_pct": 50,
     "rear_m": {"no_nlv": 5.0, "nlv": 6.0}, "side_m": {"no_nlv": 5.0, "nlv": 6.0},
     "note": "frontage is printed as 'Above 40m' in the summary (unclear)"},
]

# ---------------------------------------------------------------- CMC 2008 plan
FORM_C1 = [
    # min_area, max_area (exclusive; None = open), public street width between
    # building lines (m, None = not applicable), private street width (m), FAR (None=unlimited)
    (150, 250, None, 3.0, 1.5),
    (150, 250, None, 4.5, 1.75),
    (150, 250, None, 6.0, 2.0),
    (150, 250, None, 9.0, 2.5),
    (150, 250, 12.2, 12.2, 3.0),
    (250, 400, 12.2, 6.0, 3.5),
    (400, 500, 12.2, 9.0, 4.5),
    (500, 700, 12.2, 9.0, 5.0),
    (500, 700, 15.0, 12.2, 5.5),
    (700, 900, 15.0, 12.2, 6.0),
    (900, 1000, 15.0, 12.2, 7.0),
    (900, 1000, 22.0, 12.2, 7.5),
    (1000, 1500, 22.0, 12.2, 8.0),
    (1500, 2000, 22.0, 12.2, 9.0),
    (1500, 2000, 24.0, 12.2, 9.5),
    (2000, 2500, 24.0, 12.2, 10.0),
    (2500, 3000, 24.0, 12.2, 12.0),
    (3000, None, 24.0, 12.2, None),
]
form_c1 = [
    {"min_area": a, "max_area": b, "public_bl_width_m": pub, "private_street_m": priv, "far": far}
    for (a, b, pub, priv, far) in FORM_C1
]

FORM_C2 = [
    # floors (incl. ground) lower/upper, category, frontage, coverage, rear, one_side, each_side
    (1, 1, "Low rise", 6.0, 65, 2.3, None, None),
    (2, 2, "Low rise", 6.0, 65, 2.3, None, None),
    (3, 3, "Low rise", 6.0, 65, 3.0, None, None),
    (4, 4, "Low rise", 6.0, 65, 3.0, None, None),
    (5, 5, "Intermediate rise", 8.0, 65, 3.0, 2.0, None),
    (6, 6, "Intermediate rise", 10.0, 65, 4.0, 2.0, None),
    (7, 7, "Intermediate rise", 14.0, 65, 4.0, 3.0, None),
    (8, 8, "Intermediate rise", 16.0, 65, 4.0, 3.0, None),
    (9, 9, "Middle rise", 22.0, 65, 5.0, None, 2.0),
    (10, 10, "Middle rise", 26.0, 65, 5.0, None, 3.0),
    (11, 11, "Middle rise", 30.0, 65, 5.0, None, 3.0),
    (12, 12, "Middle rise", 30.0, 65, 5.0, None, 3.0),
    (13, 13, "High rise", 35.0, 50, 6.0, None, 4.0),
    (14, 14, "High rise", 35.0, 50, 6.0, None, 4.0),
    (15, 20, "High rise", 40.0, 50, 6.0, None, 6.0),
    (21, None, "High rise", 40.0, 50, 6.0, None, 6.0),
]
form_c2 = [
    {"floors_min": a, "floors_max": b, "category": c, "min_frontage_m": f, "max_coverage_pct": cov,
     "min_rear_m": rear, "min_one_side_m": one, "min_each_side_m": each}
    for (a, b, c, f, cov, rear, one, each) in FORM_C2
]

concentrated_far = [
    {"min_area": 1500, "max_area": 2000, "bl_width_m": 22.0, "far": 10.0},
    {"min_area": 1500, "max_area": 2000, "bl_width_m": 24.0, "far": 11.0},
    {"min_area": 2000, "max_area": None, "bl_width_m": 24.0, "far": None},
]

# Use-keys used in the matrix below
USES = {
    "dwelling": "Dwelling house",
    "apartment": "Apartments",
    "retail": "Retail shops",
    "wholesale": "Wholesale",
    "office_bank": "Offices / banks",
    "chancery": "Chanceries",
    "hotel": "Hotels",
    "restaurant": "Restaurants",
    "education": "Educational institutions",
    "health": "Health institutions",
    "worship": "Places of worship",
    "recreation": "Recreation / sports",
    "amusement": "Amusement / entertainment",
    "socio_cultural": "Socio-cultural",
    "warehouse": "Warehouses / stores",
    "industry_light": "Light / service industry",
    "port": "Port-related activity",
    "petrol": "Petrol station",
    "parking": "Vehicle park",
    "personal_services": "Personal services",
    "open_air_trading": "Open-air trading",
}


def use_map(yes=(), cond=None):
    m = {}
    for u in yes:
        m[u] = {"status": "yes"}
    for u, note in (cond or {}).items():
        m[u] = {"status": "conditional", "note": note}
    return m


CMC_ZONES = [
    {
        "id": "SPR", "name": "Special Primary Residential", "section": "4.1",
        "far_rule": "form_c1",
        "far_note": "Form C1 / C2 are referenced in 4.1(e). Coverage and height caps below also apply.",
        "max_coverage_pct": 65, "coverage_note": "50% for lots of 2,500 m2 or more",
        "coverage_large_lot": {"min_area": 2500, "pct": 50},
        "max_floors": 5, "height_note": "5 storeys (G+4). Existing lots 150-299 m2: G+2; 300-499 m2: G+3.",
        "min_plot_m2": 500,
        "uses": use_map(["dwelling", "apartment"], {
            "hotel": "limited - see 4.1", "restaurant": "limited - see 4.1", "office_bank": "limited - see 4.1",
            "education": "schools permitted", "retail": "up to 50 m2", "worship": "permitted",
            "socio_cultural": "permitted", "petrol": "permitted", "parking": "permitted", "recreation": "outdoor recreation"}),
    },
    {
        "id": "PR", "name": "Primary Residential", "section": "4.2", "far_rule": "form_c1",
        "far_note": "FAR, coverage, floors and spaces per Form C1 / C2.",
        "min_plot_m2": None,
        "uses": use_map(["dwelling", "apartment"], {
            "office_bank": "banks / offices up to 200 m2", "retail": "up to 100 m2", "education": "schools permitted",
            "worship": "permitted", "socio_cultural": "permitted", "recreation": "permitted",
            "parking": "permitted", "petrol": "permitted"}),
    },
    {
        "id": "SMR", "name": "Special Mixed Residential", "section": "4.3", "far_rule": "form_c1",
        "far_note": "FAR, coverage, floors and spaces per Form C1 / C2.",
        "uses": use_map(["dwelling", "apartment"], {
            "restaurant": "site larger than 1,000 m2", "office_bank": "offices / institutions: site larger than 500 m2"}),
    },
    {
        "id": "SF", "name": "Sea Front", "section": "4.4", "far_rule": "form_c1",
        "far_note": "Form C1 / C2 apply.", "max_coverage_pct": 50,
        "coverage_note": "50% for lots of 500 m2 or more", "coverage_large_lot": {"min_area": 500, "pct": 50},
        "min_plot_m2": 500,
        "uses": use_map(["dwelling", "apartment", "office_bank", "hotel", "restaurant", "open_air_trading",
                         "education", "worship", "socio_cultural", "recreation", "amusement", "parking",
                         "petrol", "personal_services"]),
    },
    {
        "id": "MD", "name": "Mixed Development", "section": "4.5", "far_rule": "form_c1",
        "far_note": "FAR, coverage, floors and spaces per Form C1 / C2.",
        "uses": use_map(["chancery", "office_bank", "retail", "hotel", "restaurant", "dwelling", "apartment",
                         "health", "education", "open_air_trading", "personal_services", "amusement", "worship",
                         "socio_cultural", "industry_light", "recreation", "parking", "petrol"]),
    },
    {
        "id": "PRA", "name": "Port Related Activity", "section": "4.6", "far_rule": "form_c1",
        "far_note": "Form C1 / C2 apply. 3.0 m pollution buffer around the site; minimum street width 12 m.",
        "min_plot_m2": 600, "min_plot_note": "600 m2 for port-related uses",
        "uses": use_map(["warehouse", "port", "industry_light", "office_bank", "wholesale", "retail", "hotel", "dwelling",
                         "apartment", "health", "education", "amusement", "worship", "socio_cultural", "recreation",
                         "parking", "petrol"]),
    },
    {
        "id": "COM", "name": "Commercial", "section": "4.7", "far_rule": "form_c1",
        "far_note": "FAR, coverage, floors and spaces per Form C1 / C2.",
        "uses": use_map(["chancery", "office_bank", "wholesale", "retail", "personal_services", "hotel", "dwelling",
                         "apartment", "health", "education", "industry_light", "open_air_trading", "amusement",
                         "worship", "socio_cultural", "recreation", "parking", "petrol"],
                        {"warehouse": "each warehouse up to 1,000 m2"}),
    },
    {
        "id": "CD", "name": "Concentrated Development", "section": "4.8", "far_rule": "concentrated",
        "far_note": "Special FAR for lots of 1,500 m2 and above (4.8(e)); other lots follow Form C1 / C2.",
        "uses": use_map(["chancery", "office_bank", "retail", "hotel", "dwelling", "apartment", "health", "education",
                         "open_air_trading", "personal_services", "amusement", "worship", "socio_cultural",
                         "industry_light", "recreation", "parking"]),
    },
    {
        "id": "POS", "name": "Public Open Spaces", "section": "4.9", "far_rule": "open_space",
        "far_note": "Total building floor area is capped at 2% of the open space (an effective FAR of 0.02).",
        "open_space_cap": 0.02,
        "uses": use_map(["recreation"]),
    },
    {
        "id": "DGP1-I", "name": "Development Guide Plan Area I - Zone I Conservation", "section": "8.1(a)",
        "far_rule": "none_conservation",
        "far_note": "No new construction, except essential structures supporting existing development.",
        "uses": {},
    },
    {
        "id": "DGP1-II", "name": "Development Guide Plan Area I - Zone II Leisure & Recreational", "section": "8.1(b)",
        "far_rule": "coverage_floors", "max_coverage_pct": 10, "max_floors": 3, "height_note": "G+2",
        "min_plot_m2": 2000, "min_rear_m": 3.0, "min_side_m": 3.0,
        "far_note": "No FAR is stated; coverage 10%, G+2, minimum site 2,000 m2, rear and side space 3.0 m.",
        "uses": use_map(["restaurant", "recreation"]),
    },
    {
        "id": "DGP1-III", "name": "Development Guide Plan Area I - Zone III Institutional", "section": "8.1(c)",
        "far_rule": "coverage_floors", "max_coverage_pct": 50, "max_floors": 4,
        "height_note": "G+3 facing Gregory's Road; G+2 elsewhere", "min_plot_m2": 1000, "min_rear_m": 3.0, "min_side_m": 3.0,
        "far_note": "No FAR is stated; coverage 50%, minimum site 1,000 m2, rear and side space 3.0 m. Residential use except apartments permitted by Gazette 2105/24 (8.1.2).",
        "uses": use_map(["education", "worship", "socio_cultural", "parking"], {"dwelling": "residential except apartments (Gazette 2105/24)"}),
    },
    {
        "id": "DGP1-IV", "name": "Development Guide Plan Area I - Zone IV Cultural & Amusement", "section": "8.1(d)",
        "far_rule": "coverage_floors", "max_coverage_pct": 50, "max_floors": 3, "height_note": "G+2",
        "min_plot_m2": 1000, "min_rear_m": 3.0, "min_side_m": 3.0,
        "far_note": "No FAR is stated; coverage 50%, G+2, minimum site 1,000 m2, rear and side space 3.0 m.",
        "uses": use_map(["amusement", "socio_cultural", "parking"]),
    },
    {
        "id": "DGP2", "name": "Development Guide Plan Area II - Beira Lake & surroundings", "section": "8.2",
        "far_rule": "clearance_only",
        "far_note": "No zone specifications are given; UDA planning clearance is required before building plans are submitted.",
        "uses": {},
    },
]

rules = {
    "meta": {
        "built": "2026-10-19",
        "unit_conversions": {"perch_to_m2": 25.29285264, "sqft_to_m2": 0.09290304, "acre_to_m2": 4046.8564224,
                             "hectare_to_m2": 10000.0, "ft_to_m": 0.3048},
        "verification": ("Figures were transcribed from documents read through a web reader on 2026-10-19 "
                         "(municipal / UDA copies of the gazettes). Treat them as a working dataset and confirm "
                         "against the gazette before submitting plans."),
    },
    "regimes": {
        "uda2021": {
            "id": "uda2021",
            "name": "UDA Planning & Development Regulations 2021",
            "citation": "Gazette Extraordinary 2235/54 of 8 July 2021, Schedule 6 (Forms A, B, C, D, E)",
            "source_url": "https://www.uda.gov.lk/attachments/act/2235-54_E.pdf",
            "summary_url": "https://www.kotte.mc.gov.lk/images/pdf/Planning/PnBR_Schedules_2021_Summarized.pdf",
            "status_note": ("UDA's regulations page lists these as the applicable regulations; the 2020 regulations are on its "
                            "expired list. Where an approved development plan has its own zoning regulations (floors or FAR), those govern instead."),
            "extent_bands": EXTENT_BANDS,
            "road_cols": ROAD_COLS,
            "form_a": form_a,
            "form_c_density_to_band": {"low": "0.50-0.74", "medium": "0.75-0.99", "high": "1.00-1.24"},
            "form_b_floors": form_b_floors,
            "form_d_floors": form_d_floors,
            "form_e": form_e,
            "far_cap_no_building_line": 9.0,
            "far_min_road_for_10_or_more_m": 12.0,
            "slope_nbro_clearance_deg": 11,
            "notes": [
                "Parking floor area is not counted in FAR.",
                "Permissible floor area is computed on the site excluding any part within street lines (Reg. 47).",
                "A 7 m road identified in a development plan is treated as a 6 m road (Form A footnote).",
                "FAR of 10.0 or more is allowed only on roads at least 12 m wide.",
                "Where no building line exists, maximum FAR is 9.0.",
                "FAR may be restricted by the development plan on sloping land; slopes above 11 degrees need NBRO clearance (the summary prints the figure ambiguously - confirm in the gazette).",
                "FAR does not apply in zones where the zoning regulations already set floors or a FAR.",
                "Maximum building height is 3.0 m if the lot is under 150 m2, access is under 3.0 m, or frontage is under 6.0 m (Reg. 66).",
            ],
        },
        "cmc2008": {
            "id": "cmc2008",
            "name": "City of Colombo Development Plan (Amendment) 2008 - Colombo Municipal Council area",
            "citation": ("CCDP 1999 and Amendment 2008 (Gazette 1535/4), as amended by Gazettes 2105/22, 2105/23 and 2105/24 of 2019; "
                         "Forms C1 and C2, section 4 (zones) and section 8 (Development Guide Plans)"),
            "source_url": "https://www.colombo.mc.gov.lk/downloads/ccdp-2008.pdf",
            "amendment_url": "https://www.documents.gov.lk/view/extra-gazettes/2019/1/2105-24_E.pdf",
            "status_note": ("The plan is recorded as in effect for 2008-2025, UDA's website lists it under 'Expired Regulations' "
                            "(combined 1999 and 2008 entry), and the Colombo Commercial City Development Plan 2019-2030 (which covers "
                            "the CMC area) has its own Volume III regulations. Confirm with UDA / CMC which regime governs your "
                            "parcel and its zone before relying on a result."),
            "uses": USES,
            "zones": CMC_ZONES,
            "form_c1": form_c1,
            "form_c2": form_c2,
            "concentrated_far": concentrated_far,
            "notes": [
                "The plan does not define FAR and lists no exclusions from floor area; additional parking floors are allowed irrespective of the Form C1 FAR (7.30) but still count toward the Form C2 floor limits.",
                "Basements must be at least 1.0 m from all boundaries (s.35(5), s.70).",
                "The Planning Committee may relax Form C1 / C2 where 20% or more of a lot falls within a building line (9.1(b)(ii)).",
                "Gazette 2105/24 (2019): Aloe Avenue building line 12 m (from 15 m); 12th Lane 5 ft from road edge; roads under 9 m wide without street lines between Marine Drive and Galle Road (Kollupitiya Junction to Kirulapone Canal) carry a 4.5 m acquisition line from the road centre, gifted to the local authority when development is requested.",
                "Gazette 2105/24 rezoned three areas to Mixed Development (from Special Mixed Residential near D.S. Senanayake Junction, and from Special Primary Residential near Col. T.G. Jayawardena Mawatha and Union Place).",
            ],
        },
        "cccdp2019": {
            "id": "cccdp2019",
            "name": "Colombo Commercial City Development Plan 2019-2030 (informational)",
            "citation": "UDA, published July 2019; Volume III holds the planning and building regulations",
            "source_url": "https://www.uda.gov.lk/attachments/devplan_detailed/Development%20Plans%202019-2030/commercial%20city/CommercialCity-eng-v1.pdf",
            "status_note": ("Covers eight local authority areas including the CMC area (103.71 km2). No gazette number or approval date was "
                            "found, and Volume III (the regulations) has not been ingested - FAR is therefore NOT calculated for this plan."),
            "bonuses_informational": [
                "+10% of the relevant FAR for a waterfront developer providing public access (plan website, not a gazette).",
                "+5% of the relevant FAR or plot coverage for solar-powered buildings, as the Authority decides (plan website).",
            ],
        },
    },
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(rules, indent=1, ensure_ascii=False))
print("wrote", OUT, OUT.stat().st_size, "bytes")
