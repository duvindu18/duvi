"""Key-fact markers (==...==) that the page turns into highlighter strokes.

The rule under test: markers only ever wrap words that are already in the answer. Nothing is added, reworded or invented, citation tags
are never touched, and a damaged marker from a language model is dropped rather than shown.
"""
import unittest

from app import highlight, llm, server

FAR_TEXT = ("Permissible FAR: 5 in the Mixed Development zone (s.4.5) - Form C1: land extent 500 to under 700 m2 , public street width "
            "at least 12.2 m . On a net site of 505.86 m2 that allows up to 2,529 m2 of floor area (FAR x net area). [S1]")


def marked(text):
    return [m for m in highlight._MARKED.findall(text)]


class Markers(unittest.TestCase):
    def test_strip_keeps_the_words(self):
        self.assertEqual(highlight.strip("a ==b c== d"), "a b c d")
        self.assertEqual(highlight.strip(None), "")
        self.assertEqual(highlight.strip("no markers here"), "no markers here")

    def test_values_with_units_dates_money_and_ratios_are_found(self):
        out = highlight.prepare("The bid security must be 2% of the estimated cost [S1], valid for 28 days beyond the bid validity. "
                                "Issued on 8 July 2021 (Rs. 5 million).")
        self.assertEqual(marked(out)[:3], ["2%", "28 days", "8 July 2021"])
        self.assertEqual(marked(highlight.prepare("A city hotel needs 1 parking space per 10 rooms [S2]")), ["1 parking space per 10 rooms"])

    def test_far_answer_marks_the_far_and_the_ranges(self):
        found = marked(highlight.prepare(FAR_TEXT))
        self.assertIn("Permissible FAR: 5", found)
        self.assertIn("500 to under 700 m2", found)
        self.assertIn("at least 12.2 m", found)

    def test_only_existing_words_are_marked(self):
        for text in (FAR_TEXT, "Open space of not less than 2 percent of the site shall be provided [S3]. Fee: Rs. 25,000 per year.",
                     "Building height up to 12 storeys on roads of 9 m or more [S1].\n\nA second paragraph with 40 ft and 15 m [S2]."):
            with self.subTest(text=text[:40]):
                self.assertEqual(highlight.strip(highlight.prepare(text)), text)

    def test_citation_tags_are_never_inside_a_mark_and_never_changed(self):
        out = highlight.prepare("Maximum coverage is 60 % [S1] on sites of 500 m2 [S2][S3] or more.")
        for m in marked(out):
            self.assertNotIn("[S", m)
        self.assertEqual(highlight._CITE.findall(out), ["[S1]", "[S2]", "[S3]"])

    def test_caps(self):
        para = " ".join(f"item {n} costs Rs. {n}00 and takes {n} days." for n in range(1, 9))
        out = highlight.prepare("\n\n".join([para] * 6))
        self.assertLessEqual(len(marked(out)), highlight.MAX_TOTAL)
        for p in out.split("\n\n"):
            self.assertLessEqual(len(marked(p)), highlight.MAX_PER_PARAGRAPH)

    def test_caution_regime_and_note_paragraphs_are_left_alone(self):
        text = "Check before relying on this: [S1] 12 m wide.\n\nRegime: 20 perch 15 m.\n\nNote: 3 floors"
        self.assertEqual(highlight.prepare(text), text)

    def test_text_without_facts_is_unchanged(self):
        text = "The procuring entity shall publish the notice before inviting bids [S1]."
        self.assertEqual(highlight.prepare(text), text)
        self.assertEqual(highlight.prepare(""), "")
        self.assertEqual(highlight.prepare(None), "")

    def test_prepare_is_stable(self):
        once = highlight.prepare(FAR_TEXT)
        self.assertEqual(highlight.prepare(once), once)


class ModelMarkers(unittest.TestCase):
    def test_well_formed_markers_from_a_model_are_kept_as_placed(self):
        text = "The ==maximum FAR is 5.0== here [S1], and the site must front a ==12.2 m street== [S2]."
        self.assertEqual(highlight.prepare(text), text)

    def test_a_marker_swallowing_a_citation_is_dropped(self):
        out = highlight.prepare("The ==maximum FAR is 5.0== here [S1], and ==a bad [S2] marker== plus an == unbalanced one.")
        self.assertEqual(marked(out), ["maximum FAR is 5.0"])
        self.assertNotIn("== unbalanced", out)
        self.assertEqual(highlight.strip(out).replace("==", ""), "The maximum FAR is 5.0 here [S1], and a bad [S2] marker plus an  unbalanced one.")

    def test_all_markers_damaged_falls_back_to_pattern_marking(self):
        out = highlight.prepare("Coverage is 60% [S1] and ==broken [S2]==")
        self.assertEqual(marked(out), ["60%"])
        self.assertNotIn("==broken", out)

    def test_stray_equals_signs_never_reach_the_page(self):
        out = highlight.prepare("a == b with no closing marker and 12 m")
        self.assertNotIn("== b", out)
        self.assertEqual(marked(out), ["12 m"])


def setUpModule():
    server.create_app()


class Through(unittest.TestCase):
    """The markers travel with the answer from the server, and are only emphasis: the same text without them is what a model wrote."""

    @classmethod
    def setUpClass(cls):
        cls.c = server.app.test_client()

    def test_far_answer_from_the_server_carries_markers(self):
        r = self.c.post("/api/ask", json={"question": "What is the maximum FAR for a 20 perch plot on a 40 ft road in the Colombo Municipal Council area, Mixed Development zone?"})
        a = r.get_json()["answer"]
        self.assertIn("==Permissible FAR: 5==", a)
        self.assertLessEqual(len(marked(a)), highlight.MAX_TOTAL)
        self.assertNotIn("==", highlight.strip(a))

    def test_a_model_answer_keeps_its_own_markers(self):
        real = llm.answer
        llm.answer = lambda *a, **k: {"answer": "The ==bid security is 2%== of the estimate [S1].", "mode": "llm", "model": "mock"}
        try:
            r = self.c.post("/api/ask", json={"question": "What is the bid security requirement in the national competitive bidding goods document?"}).get_json()
        finally:
            llm.answer = real
        self.assertEqual(r["answer"], "The ==bid security is 2%== of the estimate [S1].")

    def test_history_sent_to_the_model_has_no_markers(self):
        passages = [{"chunk_id": 1, "doc_id": "d", "title": "Doc", "page": 1, "text": "Bid security is 2 percent.", "status": "current", "origin": "reference", "score": 1.0}]
        history = [{"role": "user", "content": "bid security?"}, {"role": "assistant", "content": "The ==bid security is 2%== of the estimate [S1]."}]
        prompt = llm.build_prompt("and for works?", passages, None, None, history)
        self.assertIn("The bid security is 2% of the estimate [S1].", prompt)
        self.assertNotIn("==", prompt)


if __name__ == "__main__":
    unittest.main()
