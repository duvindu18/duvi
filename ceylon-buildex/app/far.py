"""Floor Area Ratio (FAR) engine for Sri Lankan planning regimes.

Regimes (all data lives in data/rules/far_rules.json so it can be corrected or extended):

  cmc2008  City of Colombo Development Plan (Amendment) 2008 - Colombo MC area.
           Zone functions (section 4 / 8), Form C1 (FAR), Form C2 (coverage, spaces).
  uda2021  UDA Planning & Development Regulations 2021 (Gazette 2235/54), Schedule 6.
           Form A (zone factor), Form C (density), Form B/D (narrow roads), Form E.

The engine never invents a number: if a value is not in the dataset the result says so.
Every result carries the regime, the exact table row used, citations and a status note.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

RULES_PATH = Path(__file__).resolve().parent.parent / "data" / "rules" / "far_rules.json"
_RULES: dict | None = None
WIDTH_TOL = 0.02  # metres of tolerance when comparing a width to a printed minimum (40 ft = 12.19 m vs 12.2 m)


def rules() -> dict:
    global _RULES
    if _RULES is None:
        _RULES = json.loads(RULES_PATH.read_text())
    return _RULES


def reload_rules() -> None:
    global _RULES
    _RULES = None


# ------------------------------------------------------------------ units
def to_m2(value: float, unit: str) -> float:
    conv = rules()["meta"]["unit_conversions"]
    unit = (unit or "m2").lower()
    if unit in ("m2", "sqm", "sq.m", "m²"):
        return float(value)
    if unit in ("perch", "perches", "p"):
        return float(value) * conv["perch_to_m2"]
    if unit in ("sqft", "sq.ft", "ft2", "sf"):
        return float(value) * conv["sqft_to_m2"]
    if unit in ("acre", "acres"):
        return float(value) * conv["acre_to_m2"]
    if unit in ("ha", "hectare", "hectares"):
        return float(value) * conv["hectare_to_m2"]
    raise ValueError(f"unknown area unit: {unit}")


def to_m(value: float, unit: str) -> float:
    unit = (unit or "m").lower()
    if unit in ("m", "meter", "metre", "meters", "metres"):
        return float(value)
    if unit in ("ft", "feet", "foot"):
        return float(value) * rules()["meta"]["unit_conversions"]["ft_to_m"]
    raise ValueError(f"unknown length unit: {unit}")


def _r(x, nd=2):
    return None if x is None else round(float(x), nd)


def _num(d: dict, key: str, default=None):
    v = d.get(key)
    if v in (None, ""):
        return default
    return float(v)


# ------------------------------------------------------------------ options for the UI
def options() -> dict:
    R = rules()["regimes"]
    cmc = R["cmc2008"]
    uda = R["uda2021"]
    return {
        "regimes": [
            {"id": "cmc2008", "name": cmc["name"], "citation": cmc["citation"], "status_note": cmc["status_note"],
             "source_url": cmc["source_url"]},
            {"id": "uda2021", "name": uda["name"], "citation": uda["citation"], "status_note": uda["status_note"],
             "source_url": uda["source_url"]},
        ],
        "cmc_zones": [{"id": z["id"], "name": z["name"], "section": z["section"], "far_note": z.get("far_note", ""),
                       "far_rule": z["far_rule"]} for z in cmc["zones"]],
        "uses": cmc["uses"],
        "zone_factor_bands": list(uda["form_a"].keys()),
        "densities": list(uda["form_c_density_to_band"].keys()),
        "area_units": ["m2", "perch", "sqft", "acre", "hectare"],
        "length_units": ["m", "ft"],
        "unit_conversions": rules()["meta"]["unit_conversions"],
        "other_regimes": [{"id": "cccdp2019", "name": R["cccdp2019"]["name"], "status_note": R["cccdp2019"]["status_note"],
                           "source_url": R["cccdp2019"]["source_url"]}],
    }


# ------------------------------------------------------------------ helpers
def _check(name: str, status: str, detail: str) -> dict:
    return {"name": name, "status": status, "detail": detail}


def _c2_for_floors(floors: int) -> dict | None:
    for row in rules()["regimes"]["cmc2008"]["form_c2"]:
        lo, hi = row["floors_min"], row["floors_max"]
        if floors >= lo and (hi is None or floors <= hi):
            return row
    return None


def _c2_coverage_for(n: int) -> float:
    row = _c2_for_floors(n)
    return row["max_coverage_pct"] / 100.0 if row else 0.5


def _floors_needed(far: float) -> int | None:
    """Smallest number of floors that can use the whole FAR at the Form C2 maximum coverage."""
    for n in range(1, 61):
        if n * _c2_coverage_for(n) >= far:
            return n
    return None


def _in_band(area: float, lo: float, hi: float | None) -> bool:
    return area >= lo and (hi is None or area < hi)


# ------------------------------------------------------------------ CMC 2008 plan
def _cmc_c1(area: float, street_type: str, width: float) -> tuple[dict | None, list[dict], str]:
    """Pick the Form C1 row. Returns (row|None, candidate rows, reason)."""
    c1 = rules()["regimes"]["cmc2008"]["form_c1"]
    cands = [r for r in c1 if _in_band(area, r["min_area"], r["max_area"])]
    if not cands:
        return None, [], f"Land extent {area:.1f} m2 is below the 150 m2 minimum of Form C1."
    ok = []
    for r in cands:
        pub, priv = r["public_bl_width_m"], r["private_street_m"]
        if street_type == "public":
            need = pub if pub is not None else priv
        else:
            need = priv
        if width + WIDTH_TOL >= need:   # 12.2 m in the plan is the metric form of 40 ft (12.19 m)
            ok.append(r)
    if not ok:
        need_min = min((r["public_bl_width_m"] if (street_type == "public" and r["public_bl_width_m"] is not None)
                        else r["private_street_m"]) for r in cands)
        kind = "width between building lines" if street_type == "public" else "private street width"
        return None, cands, (f"The {kind} ({width:.1f} m) is below the minimum of {need_min:g} m that Form C1 "
                             f"requires for this land extent, so Form C1 gives no permissible FAR.")
    best = max(ok, key=lambda r: math.inf if r["far"] is None else r["far"])
    return best, cands, ""


def _cmc_concentrated(area: float, bl_width: float, street_type: str) -> dict | None:
    if street_type != "public":
        return None
    best = None
    for r in rules()["regimes"]["cmc2008"]["concentrated_far"]:
        if _in_band(area, r["min_area"], r["max_area"]) and bl_width + WIDTH_TOL >= r["bl_width_m"]:
            if best is None or (r["far"] is None) or (best["far"] is not None and r["far"] > best["far"]):
                best = r
    return best


def calc_cmc2008(inp: dict) -> dict:
    R = rules()["regimes"]["cmc2008"]
    zones = {z["id"]: z for z in R["zones"]}
    zone = zones.get(inp.get("zone") or "")
    if not zone:
        raise ValueError("Choose a CMC zone.")
    gross = to_m2(_num(inp, "land_extent", 0), inp.get("land_unit", "m2"))
    reserve = to_m2(_num(inp, "reserve_area", 0), inp.get("land_unit", "m2"))
    if gross <= 0:
        raise ValueError("Land extent must be greater than zero.")
    net = max(gross - reserve, 0.0)
    street_type = (inp.get("street_type") or "public").lower()
    width = to_m(_num(inp, "road_width", 0), inp.get("road_unit", "m"))
    prop = inp.get("proposed") or {}
    floors = int(prop["floors"]) if prop.get("floors") not in (None, "") else None
    footprint = _num(prop, "footprint_m2")
    gfa = _num(prop, "gfa_m2")
    parking = _num(prop, "parking_m2", 0.0)
    frontage = _num(prop, "frontage_m")
    use = prop.get("use") or inp.get("use")

    res: dict[str, Any] = {
        "regime": "cmc2008", "regime_name": R["name"], "citation": R["citation"], "status_note": R["status_note"],
        "zone": {"id": zone["id"], "name": zone["name"], "section": zone["section"]},
        "inputs": {"gross_area_m2": _r(gross), "reserve_area_m2": _r(reserve), "net_area_m2": _r(net),
                   "street_type": street_type, "road_width_m": _r(width)},
        "far": {"value": None, "unlimited": False, "basis": ""},
        "checks": [], "warnings": [], "notes": list(R["notes"][:3]), "table": None,
        "citations": [
            {"doc": "City of Colombo Development Plan (Amendment) 2008", "locator": f"s.{zone['section']}; Forms C1, C2",
             "url": R["source_url"]},
            {"doc": "Gazette 2105/24 of 9 Jan 2019 (amendment)", "locator": "building lines, rezoning", "url": R["amendment_url"]},
        ],
    }
    if reserve > 0:
        res["notes"].append("Net area (land extent minus the part within street / building lines) is used for band selection "
                            "and for the floor-area calculation.")

    rule = zone["far_rule"]
    far_value: float | None = None
    unlimited = False

    # ---- zone-specific special cases
    if rule == "none_conservation":
        res["far"]["basis"] = zone["far_note"]
        res["checks"].append(_check("New construction", "fail", zone["far_note"]))
        res["max_gfa_m2"] = 0.0
        return _finish_cmc(res, zone, inp, net, None, False, use)
    if rule == "clearance_only":
        res["far"]["basis"] = zone["far_note"]
        res["warnings"].append(zone["far_note"])
        res["max_gfa_m2"] = None
        return _finish_cmc(res, zone, inp, net, None, False, use)
    if rule == "open_space":
        far_value = zone["open_space_cap"]
        res["far"].update(value=far_value, basis=zone["far_note"])
    elif rule == "coverage_floors":
        res["far"]["basis"] = zone["far_note"]
        cov = zone["max_coverage_pct"] / 100.0
        res["coverage"] = {"max_pct": zone["max_coverage_pct"], "max_footprint_m2": _r(cov * net),
                           "basis": f"s.{zone['section']}"}
        res["max_gfa_m2"] = None
        res["warnings"].append("This zone states no FAR; development is controlled by coverage, floors and minimum site size.")
        return _finish_cmc(res, zone, inp, net, None, False, use)
    else:
        # ---- Form C1 (all other zones) and the Concentrated Development special table
        row, cands, reason = _cmc_c1(net, street_type, width)
        cd_row = _cmc_concentrated(net, width, street_type) if rule == "concentrated" else None
        c1_far = None
        if row is not None:
            c1_far = math.inf if row["far"] is None else row["far"]
        cd_far = None
        if cd_row is not None:
            cd_far = math.inf if cd_row["far"] is None else cd_row["far"]
        options_ = [x for x in (c1_far, cd_far) if x is not None]
        if not options_:
            res["far"]["basis"] = reason
            res["checks"].append(_check("Permissible FAR", "fail", reason))
            res["max_gfa_m2"] = None
            res["table"] = _c1_table(cands, None)
            return _finish_cmc(res, zone, inp, net, None, False, use)
        best = max(options_)
        if best == math.inf:
            unlimited = True
        else:
            far_value = best
        if cd_far is not None and (c1_far is None or cd_far >= c1_far):
            res["far"]["basis"] = ("Concentrated Development zone, s.4.8(e): land extent "
                                   f"{cd_row['min_area']:g}{'+' if cd_row['max_area'] is None else '-' + format(cd_row['max_area'], 'g')} m2, "
                                   f"building-line width at least {cd_row['bl_width_m']:g} m")
            res["matched_row"] = cd_row
        else:
            pub = row["public_bl_width_m"]
            res["far"]["basis"] = (f"Form C1: land extent {row['min_area']:g}"
                                   f"{'+' if row['max_area'] is None else ' to under ' + format(row['max_area'], 'g')} m2, "
                                   f"{'public street' if street_type == 'public' else 'private street'} width at least "
                                   f"{(pub if (street_type == 'public' and pub is not None) else row['private_street_m']):g} m")
            res["matched_row"] = row
        res["table"] = _c1_table(cands, res.get("matched_row"))
        # alt: gross area band
        if reserve > 0:
            row_g, _, _ = _cmc_c1(gross, street_type, width)
            g_far = None if row_g is None else (math.inf if row_g["far"] is None else row_g["far"])
            if g_far is not None and g_far != best:
                res["warnings"].append(
                    f"If UDA reads the Form C1 band on the gross land extent ({gross:.0f} m2) the FAR would be "
                    f"{'unlimited' if g_far == math.inf else format(g_far, 'g')} instead - confirm with the planning authority.")
        res["far"].update(value=_r(far_value, 3), unlimited=unlimited)

    res["max_gfa_m2"] = None if unlimited else _r((far_value or 0) * net)
    if unlimited:
        res["warnings"].append("FAR is unlimited for this land extent and street width; the buildable area is governed by "
                               "plot coverage, spaces, floor limits (Form C2), parking and services.")
    return _finish_cmc(res, zone, inp, net, far_value, unlimited, use)


def _c1_table(cands, matched):
    cols = ["Land extent (m2)", "Public street, width between building lines (m)", "Private street width (m)", "Max FAR"]
    rows = []
    hl = None
    for i, r in enumerate(cands):
        ext = f"{r['min_area']:g}" + ("+" if r["max_area"] is None else f" to <{r['max_area']:g}")
        rows.append([ext, "-" if r["public_bl_width_m"] is None else f"{r['public_bl_width_m']:g}",
                     f"{r['private_street_m']:g}", "Unlimited" if r["far"] is None else f"{r['far']:g}"])
        if matched is r:
            hl = i
    return {"name": "Form C1 - rows for this land extent", "columns": cols, "rows": rows, "highlight_row": hl}


def _finish_cmc(res, zone, inp, net, far_value, unlimited, use) -> dict:
    R = rules()["regimes"]["cmc2008"]
    prop = inp.get("proposed") or {}
    floors = int(prop["floors"]) if prop.get("floors") not in (None, "") else None
    footprint = _num(prop, "footprint_m2")
    gfa = _num(prop, "gfa_m2")
    parking = _num(prop, "parking_m2", 0.0) or 0.0
    frontage = _num(prop, "frontage_m")
    checks = res["checks"]

    # ---- plot coverage / floors / spaces from the zone and Form C2
    cov_pct = zone.get("max_coverage_pct")
    if cov_pct is not None and zone.get("coverage_large_lot"):
        big = zone["coverage_large_lot"]
        cov_pct = big["pct"] if net >= big["min_area"] else (65 if zone["id"] == "SPR" else None)
    c2 = _c2_for_floors(floors) if floors else None
    if "coverage" not in res:
        pct = None
        basis = ""
        if c2:
            pct = c2["max_coverage_pct"]
            basis = f"Form C2 ({c2['category']}, {floors} floor{'s' if floors != 1 else ''})"
        if cov_pct is not None:
            pct = min(pct, cov_pct) if pct is not None else cov_pct
            basis = (basis + "; " if basis else "") + f"zone s.{zone['section']}: {zone.get('coverage_note', '')}"
        if pct is None:
            pct = 65
            basis = "Form C2 default for up to 12 floors (65%); 50% for 13 floors and above"
        res["coverage"] = {"max_pct": pct, "max_footprint_m2": _r(net * pct / 100.0), "basis": basis}
    if c2:
        res["spaces"] = {"category": c2["category"], "min_frontage_m": c2["min_frontage_m"], "min_rear_m": c2["min_rear_m"],
                         "min_one_side_m": c2["min_one_side_m"], "min_each_side_m": c2["min_each_side_m"],
                         "basis": f"Form C2, {floors} floors"}
    if far_value and not unlimited:
        n = _floors_needed(far_value)
        if n:
            res["indicative"] = {"floors_to_use_full_far": n,
                                 "text": f"To use the whole FAR at the Form C2 maximum coverage you would need about {n} floor{'s' if n != 1 else ''}."}
    if zone.get("max_floors") and floors:
        if floors > zone["max_floors"]:
            checks.append(_check("Zone floor limit", "fail", f"{floors} floors exceeds the zone maximum of {zone['max_floors']} ({zone.get('height_note', '')})."))
        else:
            checks.append(_check("Zone floor limit", "pass", f"{floors} floors is within the zone maximum of {zone['max_floors']}."))
    elif zone.get("height_note") and not floors:
        res["notes"].append(f"Height: {zone['height_note']}")
    if zone.get("min_plot_m2") and net < zone["min_plot_m2"]:
        checks.append(_check("Minimum plot size", "warn", f"Zone s.{zone['section']} refers to a minimum plot of {zone['min_plot_m2']} m2 "
                                                          f"({zone.get('min_plot_note', 'for new subdivisions / the listed uses')}); this lot is {net:.0f} m2."))

    # ---- proposed design checks
    if gfa is not None and net > 0:
        counted = max(gfa - parking, 0.0)
        used = counted / net
        res["design"] = {"gfa_m2": _r(gfa), "parking_excluded_m2": _r(parking), "counted_area_m2": _r(counted), "far_used": _r(used, 3)}
        if parking:
            res["warnings"].append("Parking floor area was excluded. In this plan only additional parking floors beyond the "
                                   "regulatory requirement are exempt from the Form C1 FAR (7.30); confirm yours qualify.")
        if far_value is not None and not unlimited:
            ok = used <= far_value + 1e-9
            checks.append(_check("FAR of the proposal", "pass" if ok else "fail",
                                 f"FAR used {used:.2f} against a permissible {far_value:g} "
                                 f"({'within' if ok else 'exceeds by ' + format(counted - far_value * net, '.1f') + ' m2'})."))
        elif unlimited:
            checks.append(_check("FAR of the proposal", "info", f"FAR used {used:.2f}; the permissible FAR is unlimited here."))
    if footprint is not None and res.get("coverage"):
        mx = res["coverage"]["max_footprint_m2"]
        pct_used = 100.0 * footprint / net if net else 0
        ok = footprint <= mx + 1e-9
        checks.append(_check("Plot coverage", "pass" if ok else "fail",
                             f"Footprint {footprint:.1f} m2 is {pct_used:.1f}% of the lot; maximum {res['coverage']['max_pct']}% ({mx:.1f} m2)."))
    if frontage is not None and c2:
        ok = frontage + 1e-9 >= c2["min_frontage_m"]
        checks.append(_check("Site frontage", "pass" if ok else "fail",
                             f"Frontage {frontage:g} m against the Form C2 minimum of {c2['min_frontage_m']:g} m for {floors} floors."))
    if use:
        z_uses = zone.get("uses", {})
        label = R["uses"].get(use, use)
        info = z_uses.get(use)
        if info is None:
            checks.append(_check("Use in this zone", "warn", f"'{label}' is not in the permitted-use list summarised for s.{zone['section']}; "
                                                              "it may need a decision by the Planning Committee."))
        elif info["status"] == "yes":
            checks.append(_check("Use in this zone", "pass", f"'{label}' is listed as a permitted use in s.{zone['section']}."))
        else:
            checks.append(_check("Use in this zone", "warn", f"'{label}' is permitted subject to: {info['note']} (s.{zone['section']})."))
    res["notes"].append(zone.get("far_note", ""))
    res["notes"] = [n for n in dict.fromkeys(res["notes"]) if n]
    return res


# ------------------------------------------------------------------ UDA 2021
def _zf_band(zf: float) -> str | None:
    bands = list(rules()["regimes"]["uda2021"]["form_a"].keys())
    if zf < 0.50 or zf > 4.0:
        return None
    pick = None
    for b in bands:
        lo = float(b.split("-")[0])
        if zf + 1e-9 >= lo:
            pick = b
    return pick


def _extent_row(area: float) -> int | None:
    """Row index of the Form A / C land-extent band for `area` (m2).

    Bands are printed as 150-250, 250-375, ... 3500-4000, more than 4000.  A value that sits
    exactly on a printed boundary is placed in the LOWER band (the conservative reading).
    """
    bands = rules()["regimes"]["uda2021"]["extent_bands"]
    eps = 1e-9
    if area < bands[0] - eps:
        return None
    if abs(area - bands[0]) <= eps:
        return 0
    for i in range(len(bands) - 1):
        if bands[i] + eps < area <= bands[i + 1] + eps:
            return i
    return len(bands) - 1  # more than 4000


def _on_boundary(area: float) -> float | None:
    for b in rules()["regimes"]["uda2021"]["extent_bands"][1:]:
        if abs(area - b) <= 1e-9:
            return b
    return None


def _road_col(w: float) -> tuple[int | None, str]:
    if w >= 15:
        return 3, "15 m and above"
    if w >= 12:
        return 2, "12 m"
    if w >= 9:
        return 1, "9 m"
    if w >= 6:
        return 0, "6 m" + (" (a road of 7 m identified in the development plan is treated as 6 m)" if 7 <= w < 9 else "")
    return None, ""


def _fv(x) -> float:
    return float("inf") if x == "UL" else float(x)


def form_a_anomalies() -> list[dict]:
    """Cells of the printed Form A grid that break the table's own pattern (a narrower road, a smaller plot or a lower zone
    factor giving MORE floor area than its neighbour). They are re-checked against the source and kept as printed;
    the calculator warns when a result lands on one, because the source may carry a misprint."""
    fa = rules()["regimes"]["uda2021"]["form_a"]
    bands = list(fa)
    out: list[dict] = []
    for bi, b in enumerate(bands):
        for i, row in enumerate(fa[b]):
            for c in range(3):
                if _fv(row[c]) > _fv(row[c + 1]):
                    out.append({"band": b, "row": i, "col": c, "kind": "road", "value": row[c], "other": row[c + 1],
                                "cells": [(b, i, c), (b, i, c + 1)]})
            if i:
                for c in range(4):
                    if _fv(fa[b][i - 1][c]) > _fv(row[c]):
                        out.append({"band": b, "row": i, "col": c, "kind": "extent", "value": fa[b][i - 1][c], "other": row[c],
                                    "cells": [(b, i - 1, c), (b, i, c)]})
            if bi:
                for c in range(4):
                    if _fv(fa[bands[bi - 1]][i][c]) > _fv(row[c]):
                        out.append({"band": b, "row": i, "col": c, "kind": "zone", "value": fa[bands[bi - 1]][i][c], "other": row[c],
                                    "cells": [(bands[bi - 1], i, c), (b, i, c)]})
    return out


def _anomaly_warning(band: str, row: int, col: int) -> str | None:
    for a in form_a_anomalies():
        if (band, row, col) in a["cells"]:
            what = {"road": "a narrower road", "extent": "a smaller plot", "zone": "a lower zone-factor band"}[a["kind"]]
            return (f"This cell of the printed Form A table breaks the table's own pattern ({what} shows {a['value']} where the neighbouring "
                    f"cell shows {a['other']}). It was re-checked against the source summary and is given as printed, but it may be a misprint - "
                    "confirm the figure against Gazette 2235/54 or with the UDA.")
    return None


def calc_uda2021(inp: dict) -> dict:
    R = rules()["regimes"]["uda2021"]
    gross = to_m2(_num(inp, "land_extent", 0), inp.get("land_unit", "m2"))
    reserve = to_m2(_num(inp, "reserve_area", 0), inp.get("land_unit", "m2"))
    if gross <= 0:
        raise ValueError("Land extent must be greater than zero.")
    net = max(gross - reserve, 0.0)
    width = to_m(_num(inp, "road_width", 0), inp.get("road_unit", "m"))
    density = (inp.get("density") or "").lower() or None
    zf = _num(inp, "zone_factor")
    if zf is None and density is None:
        raise ValueError("Give a zone factor (0.50 - 4.00) or a density (low / medium / high).")
    band = None
    basis_zone = ""
    if zf is not None:
        band = _zf_band(zf)
        if band is None:
            raise ValueError("Zone factor must be between 0.50 and 4.00.")
        basis_zone = f"zone factor {zf:g} (Form A band {band})"
    else:
        if density not in R["form_c_density_to_band"]:
            raise ValueError("Density must be low, medium or high.")
        band = R["form_c_density_to_band"][density]
        basis_zone = f"{density} density (Form C, same figures as Form A band {band})"
    has_bl = inp.get("has_building_line", True)
    has_bl = True if has_bl in (None, "") else bool(has_bl)
    slope = _num(inp, "slope_deg")
    prop = inp.get("proposed") or {}
    floors = int(prop["floors"]) if prop.get("floors") not in (None, "") else None
    footprint = _num(prop, "footprint_m2")
    gfa = _num(prop, "gfa_m2")
    parking = _num(prop, "parking_m2", 0.0) or 0.0
    height = _num(prop, "height_m")
    residential = prop.get("residential", True)
    residential = True if residential in (None, "") else bool(residential)

    res: dict[str, Any] = {
        "regime": "uda2021", "regime_name": R["name"], "citation": R["citation"], "status_note": R["status_note"],
        "inputs": {"gross_area_m2": _r(gross), "reserve_area_m2": _r(reserve), "net_area_m2": _r(net),
                   "road_width_m": _r(width), "zone_basis": basis_zone},
        "far": {"value": None, "unlimited": False, "basis": ""},
        "checks": [], "warnings": [], "notes": list(R["notes"]), "table": None,
        "citations": [
            {"doc": "UDA Planning & Development Regulations 2021 (Gazette 2235/54)", "locator": "Schedule 6, Forms A-E",
             "url": R["source_url"]},
            {"doc": "Kotte MC summary of the 2021 schedules", "locator": "Forms A-E", "url": R["summary_url"]},
        ],
    }
    checks = res["checks"]
    if reserve > 0:
        res["notes"].insert(0, "Net area (land extent minus the part within street lines) is used for the floor-area calculation (Reg. 47).")

    col, col_label = _road_col(width)
    if col is None:
        # ---- narrow roads: Form B (zone factor) / Form D (density) give floors, not FAR
        if width < 3.0:
            res["far"]["basis"] = "Road narrower than 3.0 m: below the minimum road width of Forms B and D."
            checks.append(_check("Road width", "fail", "Forms B and D start at a 3.0 m road; Reg. 66 limits buildings to 3.0 m high where access is under 3.0 m."))
            res["max_gfa_m2"] = None
            return res
        rcol = "4.5" if width >= 4.5 else "3.0"
        if zf is not None:
            grp = next(k for k in R["form_b_floors"] if float(k.split("-")[0]) - 1e-9 <= zf <= float(k.split("-")[1]) + 0.0099)
            n = R["form_b_floors"][grp][rcol]
            src = f"Form B: zone factor band {grp}, {rcol} m road"
        else:
            n = R["form_d_floors"][density]
            src = f"Form D: {density} density, {rcol} m road"
        res["far"]["basis"] = f"Roads under 6 m: no FAR - {src} allows {n} floor{'s' if n != 1 else ''} (ground = 1, parking included), plot coverage 65%, minimum frontage 6 m."
        res["floors_limit"] = {"max_floors": n, "basis": src}
        res["coverage"] = {"max_pct": 65, "max_footprint_m2": _r(net * 0.65), "basis": "Forms B / D"}
        res["max_gfa_m2"] = _r(n * 0.65 * net)
        res["notes"].append("For roads under 6 m the floors limit applies instead of FAR; the figure above is floors x 65% coverage x area, an upper bound.")
        if floors:
            checks.append(_check("Floor limit", "pass" if floors <= n else "fail", f"{floors} floors against the Form B / D limit of {n}."))
        return _finish_common_uda(res, net, None, False, floors, footprint, gfa, parking, height, residential, slope, has_bl, prop)

    ridx = _extent_row(net)
    edge = _on_boundary(net)
    if edge is not None:
        res["warnings"].append(f"The net area ({net:g} m2) sits exactly on a printed band boundary ({edge:g} m2); the lower band was used - confirm with the planning authority.")
    if ridx is None:
        res["far"]["basis"] = "Land extent below the 150 m2 minimum of the FAR tables."
        checks.append(_check("Land extent", "fail", "Forms A and C start at 150 m2. Reg. 66: building height is limited to 3.0 m where the lot is under 150 m2."))
        res["max_gfa_m2"] = None
        return res
    grid = R["form_a"][band]
    raw = grid[ridx][col]
    bands = R["extent_bands"]
    ext_label = (f"{bands[ridx]:g} to {bands[ridx + 1]:g} m2" if ridx + 1 < len(bands) else f"more than {bands[ridx]:g} m2")
    far_value = None if raw == "UL" else float(raw)
    unlimited = raw == "UL"
    notes = []
    if not has_bl:
        cap = R["far_cap_no_building_line"]
        if unlimited or far_value > cap:
            notes.append(f"No building line: FAR is capped at {cap:g} (table value {'unlimited' if unlimited else format(far_value, 'g')}).")
            far_value, unlimited = cap, False
    if (unlimited or (far_value is not None and far_value >= 10)) and width < R["far_min_road_for_10_or_more_m"]:
        notes.append("FAR of 10.0 or more is allowed only on roads at least 12 m wide.")
    res["far"].update(value=_r(far_value, 3), unlimited=unlimited,
                      basis=f"Form A, {basis_zone}; land extent {ext_label}; road {col_label}")
    res["warnings"].extend(notes)
    anomaly = _anomaly_warning(band, ridx, col)
    if anomaly:
        res["warnings"].append(anomaly)
    if slope is not None and slope > R["slope_nbro_clearance_deg"]:
        res["warnings"].append(f"Slope of {slope:g} degrees exceeds {R['slope_nbro_clearance_deg']}: NBRO clearance is required and the plan may restrict FAR.")
    if unlimited:
        res["warnings"].append("FAR is unlimited here; the buildable area is governed by coverage, spaces, height category, parking and services.")
    res["table"] = {
        "name": f"Form A - zone factor band {band}", "columns": ["Land extent (m2)", "6 m road", "9 m road", "12 m road", "15 m+ road"],
        "rows": [[(f"{bands[i]:g}-{bands[i + 1]:g}" if i + 1 < len(bands) else f">{bands[i]:g}")] +
                 [("UL" if v == "UL" else f"{v:g}") for v in grid[i]] for i in range(len(grid))],
        "highlight_row": ridx, "highlight_col": col + 1,
    }
    res["max_gfa_m2"] = None if unlimited else _r((far_value or 0) * net)
    return _finish_common_uda(res, net, far_value, unlimited, floors, footprint, gfa, parking, height, residential, slope, has_bl, prop)


def _form_e_row(height_m: float) -> dict | None:
    for row in rules()["regimes"]["uda2021"]["form_e"]:
        lo, hi = row["height_m"]
        if height_m >= lo and (hi is None or height_m < hi):
            return row
    return None


def _finish_common_uda(res, net, far_value, unlimited, floors, footprint, gfa, parking, height, residential, slope, has_bl, prop):
    checks = res["checks"]
    h = height
    if h is None and floors:
        h = floors * 3.0
        res["notes"].append(f"Building height was estimated as {floors} floors x 3.0 m = {h:g} m to pick the Form E category - enter the actual height for an accurate result.")
    er = _form_e_row(h) if h is not None else None
    if er:
        cov = er["coverage_res_pct"] if residential else er["coverage_nonres_pct"]
        res["coverage"] = {"max_pct": cov, "max_footprint_m2": _r(net * cov / 100.0),
                           "basis": f"Form E, {er['category']} ({er['height_m'][0]:g}-{'' if er['height_m'][1] is None else format(er['height_m'][1], 'g')} m)"}
        res["spaces"] = {"category": er["category"], "min_frontage_m": er["min_frontage_m"], "rear_m": er["rear_m"], "side_m": er["side_m"],
                         "basis": "Form E - values as printed in the summary: 'no NLV' / 'with NLV' (natural light and ventilation)",
                         "note": er.get("note")}
        if er.get("note"):
            res["notes"].append(er["note"])
    elif "coverage" not in res:
        res["coverage"] = {"max_pct": 65, "max_footprint_m2": _r(net * 0.65), "basis": "Forms B / D / E: 65% for most categories (enter height for the exact Form E value)"}
    if far_value and not unlimited:
        n = None
        for k in range(1, 80):
            cov = 0.5 if k * 3.0 >= 50 else (0.65)
            if k * cov >= far_value:
                n = k
                break
        if n:
            res["indicative"] = {"floors_to_use_full_far": n,
                                 "text": f"At about 65% coverage (50% above 50 m height) the whole FAR needs roughly {n} floors (3.0 m each assumed)."}
    if gfa is not None and net > 0:
        counted = max(gfa - parking, 0.0)
        used = counted / net
        res["design"] = {"gfa_m2": _r(gfa), "parking_excluded_m2": _r(parking), "counted_area_m2": _r(counted), "far_used": _r(used, 3)}
        if far_value is not None and not unlimited:
            ok = used <= far_value + 1e-9
            checks.append(_check("FAR of the proposal", "pass" if ok else "fail",
                                 f"FAR used {used:.2f} (parking floors excluded) against a permissible {far_value:g}"
                                 f"{'' if ok else '; excess ' + format(counted - far_value * net, '.1f') + ' m2'}."))
        elif unlimited:
            checks.append(_check("FAR of the proposal", "info", f"FAR used {used:.2f}; permissible FAR is unlimited here."))
    if footprint is not None and res.get("coverage"):
        mx = res["coverage"]["max_footprint_m2"]
        ok = footprint <= mx + 1e-9
        checks.append(_check("Plot coverage", "pass" if ok else "fail",
                             f"Footprint {footprint:.1f} m2 = {100.0 * footprint / net:.1f}% of the lot; maximum {res['coverage']['max_pct']}% ({mx:.1f} m2)."))
    res["notes"] = list(dict.fromkeys(res["notes"]))
    return res


# ------------------------------------------------------------------ dispatcher
def calculate(inp: dict) -> dict:
    regime = (inp.get("regime") or "cmc2008").lower()
    if regime == "cmc2008":
        return calc_cmc2008(inp)
    if regime == "uda2021":
        return calc_uda2021(inp)
    if regime == "cccdp2019":
        r = rules()["regimes"]["cccdp2019"]
        raise ValueError(r["status_note"])
    raise ValueError(f"unknown regime: {regime}")


# ------------------------------------------------------------------ natural-language parsing
_AREA_RE = re.compile(
    r"(?P<num>\d[\d,]*\.?\d*)\s*(?P<unit>perch(?:es)?|sq\.?\s*(?:m|meters?|metres?)|sqm|m2|m²|square\s*(?:met(?:er|re)s?)|"
    r"sq\.?\s*ft|sqft|square\s*(?:feet|foot)|acres?|hectares?|ha\b|p\b)", re.I)
_ROAD_RE1 = re.compile(r"(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>m|metres?|meters?|ft|feet|foot|')\s*(?:wide\s*)?(?:public\s*|private\s*|access\s*)?(?:road|street|lane|access)", re.I)
_ROAD_RE2 = re.compile(r"(?:road|street|lane)\s*(?:width|of|is|=|:)?\s*(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>m|metres?|meters?|ft|feet|foot)\b", re.I)

_ZONE_KEYS = [
    ("concentrated development", "CD"), ("special primary residential", "SPR"), ("special mixed residential", "SMR"),
    ("primary residential", "PR"), ("mixed development", "MD"), ("sea front", "SF"), ("seafront", "SF"),
    ("port related", "PRA"), ("commercial zone", "COM"), ("commercial", "COM"), ("open space", "POS"),
]


def parse_question(text: str) -> dict:
    """Pull FAR inputs out of free text. Returns {'looks_like_far', 'inputs', 'missing', 'complete'}."""
    t = text or ""
    low = t.lower()
    inputs: dict[str, Any] = {}
    m = _AREA_RE.search(t)
    if m:
        num = float(m.group("num").replace(",", ""))
        u = m.group("unit").lower().replace(" ", "")
        if u.startswith("perch") or u == "p":
            unit = "perch"
        elif u.startswith("acre"):
            unit = "acre"
        elif u in ("ha", "hectare", "hectares"):
            unit = "hectare"
        elif "ft" in u or "feet" in u or "foot" in u:
            unit = "sqft"
        else:
            unit = "m2"
        inputs["land_extent"], inputs["land_unit"] = num, unit
    m = _ROAD_RE1.search(t) or _ROAD_RE2.search(t)
    if m:
        u = m.group("unit").lower()
        inputs["road_width"] = float(m.group("num"))
        inputs["road_unit"] = "ft" if u in ("ft", "feet", "foot", "'") else "m"
    for key, zid in _ZONE_KEYS:
        if key in low:
            inputs["zone"] = zid
            break
    zf = re.search(r"zone\s*factor\s*(?:of|=|:)?\s*(\d(?:\.\d+)?)", low)
    if zf:
        inputs["zone_factor"] = float(zf.group(1))
    for d in ("low", "medium", "high"):
        if re.search(rf"\b{d}\s*density\b", low):
            inputs["density"] = d
    if "street" in low and "private" in low:
        inputs["street_type"] = "private"
    if re.search(r"\bno building line\b|\bwithout (?:a )?building line\b", low):
        inputs["has_building_line"] = False
    if inputs.get("zone_factor") or inputs.get("density"):
        inputs["regime"] = "uda2021"
    elif inputs.get("zone") or re.search(r"\bcmc\b|colombo municipal|colombo city|city of colombo|colombo", low):
        inputs["regime"] = "cmc2008"
    looks = bool(re.search(r"\bfar\b|floor area ratio|plot ratio|how much (?:can|could) i build|permissible floor area|buildable area|floor area", low))
    regime = inputs.get("regime")
    missing = []
    if "land_extent" not in inputs:
        missing.append("land extent")
    if "road_width" not in inputs:
        missing.append("road width")
    if regime == "cmc2008" and "zone" not in inputs:
        missing.append("CMC zone")
    if regime == "uda2021" and not (inputs.get("zone_factor") or inputs.get("density")):
        missing.append("zone factor or density")
    if regime is None:
        missing.append("regime (CMC area or UDA area)")
    return {"looks_like_far": looks and bool(inputs), "inputs": inputs, "missing": missing, "complete": not missing and looks}
