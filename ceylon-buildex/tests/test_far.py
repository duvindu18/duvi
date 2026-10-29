"""FAR rules engine. Expected values are read off the printed gazette / development-plan tables (see data/rules/far_rules.json)."""
import json
import unittest

from app import far


def uda(**kw):
    base = dict(regime="uda2021", land_unit="m2", road_unit="m", has_building_line=True)
    base.update(kw)
    return far.calculate(base)


def cmc(**kw):
    base = dict(regime="cmc2008", land_unit="m2", road_unit="m", street_type="public")
    base.update(kw)
    return far.calculate(base)


class Units(unittest.TestCase):
    def test_perch(self):
        self.assertAlmostEqual(far.to_m2(1, "perch"), 25.29285264, places=6)
        self.assertAlmostEqual(far.to_m2(20, "perches"), 505.857, places=2)

    def test_other_units(self):
        self.assertAlmostEqual(far.to_m2(1, "acre"), 4046.8564, places=2)
        self.assertAlmostEqual(far.to_m2(1, "hectare"), 10000, places=3)
        self.assertAlmostEqual(far.to_m2(100, "sqft"), 9.2903, places=3)
        self.assertAlmostEqual(far.to_m(40, "ft"), 12.192, places=3)


class CMC(unittest.TestCase):
    def test_form_c1_600m2_public_12_2(self):
        r = cmc(zone="MD", land_extent=600, road_width=12.2)
        self.assertEqual(r["far"]["value"], 5.0)
        self.assertAlmostEqual(r["max_gfa_m2"], 3000, places=0)

    def test_40ft_counts_as_12_2m(self):
        r = cmc(zone="MD", land_extent=20, land_unit="perch", road_width=40, road_unit="ft")
        self.assertEqual(r["far"]["value"], 5.0)

    def test_12m_street_is_below_the_12_2_threshold(self):
        r = cmc(zone="MD", land_extent=600, road_width=12.0)
        self.assertNotEqual(r["far"]["value"], 5.0)           # strictly under 12.2 m: lower row or no FAR, never 5.0

    def test_concentrated_development(self):
        r = cmc(zone="CD", land_extent=1800, road_width=24)
        self.assertEqual(r["far"]["value"], 11.0)

    def test_every_zone_runs_or_explains(self):
        for z in far.options()["cmc_zones"]:
            try:
                r = cmc(zone=z["id"], land_extent=800, road_width=15)
            except ValueError as e:
                self.assertTrue(str(e))                        # zones with no FAR rule must say why
                continue
            self.assertIn("citation", r)
            self.assertTrue(r["status_note"])

    def test_status_caveat_always_present(self):
        r = cmc(zone="MD", land_extent=600, road_width=12.2)
        self.assertIn("2008", r["status_note"])
        self.assertTrue(r["citations"])


class UDA(unittest.TestCase):
    def test_zone_factor_1_1_600m2_12m(self):
        r = uda(zone_factor=1.1, land_extent=600, road_width=12)
        self.assertEqual(r["far"]["value"], 2.7)

    def test_density_high_20_perch_40ft(self):
        r = uda(density="high", land_extent=20, land_unit="perch", road_width=40, road_unit="ft")
        self.assertEqual(r["far"]["value"], 2.7)

    def test_no_building_line_cap(self):
        r = uda(zone_factor=3.9, land_extent=4000, road_width=30, has_building_line=False)
        self.assertLessEqual(r["far"]["value"], 9.0)

    def test_net_area_excludes_reserve(self):
        r = uda(zone_factor=1.1, land_extent=600, reserve_area=40, road_width=12)
        self.assertAlmostEqual(r["inputs"]["net_area_m2"], 560, places=3)

    def test_narrow_road_gives_floor_limit_not_far(self):
        r = uda(zone_factor=1.0, land_extent=200, road_width=4.5)
        self.assertTrue(r.get("floors_limit") or r["far"].get("value") is None)

    def test_invalid_inputs_rejected(self):
        with self.assertRaises((ValueError, TypeError, KeyError)):
            uda(zone_factor=1.1, land_extent=-5, road_width=12)
        with self.assertRaises(ValueError):
            far.calculate({"regime": "nonsense"})

    def test_cccdp2019_is_informational_only(self):
        with self.assertRaises(ValueError) as cm:
            far.calculate({"regime": "cccdp2019", "land_extent": 800, "road_width": 12})
        self.assertIn("Volume III", str(cm.exception))


class TableIntegrity(unittest.TestCase):
    """Structural checks that catch transcription slips: shape, ordering, monotonicity."""

    @classmethod
    def setUpClass(cls):
        cls.u = far.rules()["regimes"]["uda2021"]

    def _val(self, v):
        return float("inf") if v == "UL" else float(v)

    def test_form_a_shape(self):
        fa = self.u["form_a"]
        self.assertEqual(len(fa), 14)
        for band, rows in fa.items():
            self.assertEqual(len(rows), 12, band)
            for row in rows:
                self.assertEqual(len(row), 4, band)

    # Cells that are non-monotonic *as printed* (re-read against the Kotte MC summary of Schedule 6 on 2026-10-19). Any new entry here
    # means either a transcription slip or a newly found misprint: check the source before adding it.
    KNOWN_PRINTED_ANOMALIES = {
        ("3.75-4.00", 2, 1, "road"), ("3.75-4.00", 3, 1, "road"), ("2.00-2.24", 1, 3, "zone"), ("2.25-2.49", 2, 2, "zone"),
    }

    def test_form_a_only_known_anomalies(self):
        found = {(a["band"], a["row"], a["col"], a["kind"]) for a in far.form_a_anomalies()}
        self.assertEqual(found, self.KNOWN_PRINTED_ANOMALIES)

    def test_anomalous_cell_triggers_warning(self):
        r = uda(zone_factor=3.8, land_extent=400, road_width=9)           # 3.75-4.00, 375-500 m2, 9 m: printed 5.4 (12 m shows 5.2)
        self.assertEqual(r["far"]["value"], 5.4)
        self.assertTrue(any("misprint" in w for w in r["warnings"]), r["warnings"])

    def test_clean_cell_has_no_anomaly_warning(self):
        r = uda(zone_factor=1.1, land_extent=600, road_width=12)
        self.assertFalse(any("misprint" in w for w in r["warnings"]))

    def test_form_c1_values_are_sane(self):
        rows = far.rules()["regimes"]["cmc2008"]["form_c1"]
        self.assertEqual(len(rows), 18)
        for r in rows:
            if r["far"] is not None:                         # None = no numerical limit printed for the largest plots
                self.assertTrue(0 < r["far"] <= 12, r)
            self.assertLess(r["min_area"], r["max_area"] or 10 ** 9)

    def test_rules_json_carries_a_verification_note(self):
        self.assertIn("verification", far.rules()["meta"])


class Parse(unittest.TestCase):
    def test_colombo_question(self):
        p = far.parse_question("What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Municipal Council area, Mixed Development zone?")
        self.assertTrue(p["looks_like_far"])
        i = p["inputs"]
        self.assertEqual(i["regime"], "cmc2008")
        self.assertEqual(i["zone"], "MD")
        self.assertEqual(i["land_extent"], 20)
        self.assertEqual(i["road_width"], 40)
        self.assertEqual(p["missing"], [])
        self.assertEqual(far.calculate(i)["far"]["value"], 5.0)

    def test_uda_question(self):
        p = far.parse_question("FAR for 800 sq m with zone factor 2.0 on a 12 m road, no building line")
        self.assertTrue(p["looks_like_far"])
        self.assertEqual(p["inputs"]["regime"], "uda2021")
        self.assertEqual(p["inputs"]["zone_factor"], 2.0)
        self.assertFalse(p["inputs"]["has_building_line"])

    def test_non_far_question(self):
        self.assertFalse(far.parse_question("How much bid security is required?")["looks_like_far"])

    def test_missing_inputs_listed(self):
        p = far.parse_question("What FAR can I get in Colombo?")
        self.assertTrue(p["missing"])


if __name__ == "__main__":
    unittest.main()
