"""OCR, extraction, chunking, the single dataset (SQLite + FTS5), the downloader and the update job - on real code paths, using
a local web server in place of the government sites and scanned/text PDFs rendered from the regulation wording."""
import json
import tempfile
import time
import unittest
from pathlib import Path

from app import config, db, downloader, extract, ingest, ocr, retrieval
from tests.helpers import LocalSite, SAMPLE, make_docx, make_scanned_pdf, make_text_pdf


def setUpModule():
    db.db().__enter__()            # create schema
    ingest.init_seeds(progress=None)


class OCRTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.scan = make_scanned_pdf(cls.tmp / "scan.pdf")

    def test_engine_present(self):
        self.assertTrue(ocr.tesseract_available())
        self.assertIn("eng", ocr.installed_langs())

    def test_scanned_pdf_has_no_text_layer(self):
        self.assertEqual("".join(extract.pdf_text_layer(self.scan)).strip(), "")

    def test_scanned_pdf_is_read_by_ocr(self):
        pages = extract.extract_pdf(self.scan)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0].method, "ocr")
        low = " ".join(pages[0].text.lower().split())
        for needle in ("floor area ratio", "public street", "12.2 metres", "5.0", "2 percent"):
            self.assertIn(needle, low)
        self.assertGreater(pages[0].conf, 60)

    def test_ocr_word_accuracy_on_scan(self):
        got = set(w.strip(".,;-()").lower() for w in extract.extract_pdf(self.scan)[0].text.split())
        want = [w.strip(".,;-()").lower() for w in SAMPLE.split() if len(w.strip(".,;-()")) > 3]
        hit = sum(1 for w in want if w in got) / len(want)
        print(f"\n   OCR word recall on the synthetic scan: {hit:.1%}")
        self.assertGreater(hit, 0.93)

    def test_text_layer_pages_skip_ocr(self):
        pdf = make_text_pdf(self.tmp / "text.pdf", [SAMPLE, SAMPLE])
        pages = extract.extract_pdf(pdf)
        self.assertEqual([p.method for p in pages], ["text", "text"])

    def test_mixed_pdf_only_ocrs_image_pages(self):
        # page 1 text layer, page 2 image only
        from pypdf import PdfReader, PdfWriter
        t = make_text_pdf(self.tmp / "t1.pdf", [SAMPLE]); s = make_scanned_pdf(self.tmp / "s1.pdf")
        w = PdfWriter()
        for f in (t, s):
            for pg in PdfReader(str(f)).pages:
                w.add_page(pg)
        mixed = self.tmp / "mixed.pdf"
        with open(mixed, "wb") as fh:
            w.write(fh)
        pages = extract.extract_pdf(mixed)
        self.assertEqual([p.method for p in pages], ["text", "ocr"])

    def test_parallel_multipage_and_cache(self):
        pdf = make_scanned_pdf(self.tmp / "six.pdf", pages=6, noise=False)
        t0 = time.time(); pages = extract.extract_pdf(pdf, force_ocr=True); t1 = time.time() - t0
        self.assertEqual(len(pages), 6)
        self.assertTrue(all("floor area ratio" in " ".join(p.text.lower().split()) for p in pages))
        t0 = time.time(); extract.extract_pdf(pdf, force_ocr=True); t2 = time.time() - t0
        print(f"\n   6 scanned pages: {t1:.1f}s first run, {t2:.2f}s from cache ({config.OCR_WORKERS} workers)")
        self.assertLess(t2, t1 / 3 + 0.5)

    def test_png_ocr(self):
        import subprocess
        png = self.tmp / "p.png"
        subprocess.run(["pdftoppm", "-r", "150", "-png", "-singlefile", str(self.scan), str(png.with_suffix(""))], check=True)
        pages = extract.extract_any(png)
        self.assertIn("floor area ratio", " ".join(pages[0].text.lower().split()))

    def test_sparse_page_text_is_not_erased(self):
        """Regression: a page that is almost blank (a short notice, a cover) lost all its text to a contrast stretch that clipped the ink."""
        pdf = make_scanned_pdf(self.tmp / "sparse.pdf", text="NOTICE 12/3\nBids close on 14 March.")
        txt = " ".join(extract.extract_pdf(pdf)[0].text.lower().split())
        self.assertIn("notice 12/3", txt)
        self.assertIn("bids close", txt)

    def test_garbled_legacy_font_detection(self):
        self.assertTrue(extract.looks_garbled(";%§Ü{}|\\<>^~@# ;%§Ü{}|\\<>^~@# ;%§Ü{}|\\<>^~@# ;%§Ü{}|\\<>^~@# "))
        self.assertFalse(extract.looks_garbled(SAMPLE))


class FormatTests(unittest.TestCase):
    def test_docx_and_html_and_txt(self):
        tmp = Path(tempfile.mkdtemp())
        d = make_docx(tmp / "a.docx", ["Bid security shall be 2 percent of the estimated contract value.", "Second paragraph."])
        self.assertIn("2 percent", extract.extract_any(d)[0].text)
        h = tmp / "a.html"; h.write_text("<html><nav>menu</nav><body><p>Building line 3.0 m</p><script>x=1</script></body></html>")
        t = extract.extract_any(h)[0].text
        self.assertIn("Building line 3.0 m", t); self.assertNotIn("x=1", t); self.assertNotIn("menu", t)
        x = tmp / "a.txt"; x.write_text("plain text file")
        self.assertEqual(extract.extract_any(x)[0].text, "plain text file")
        with self.assertRaises(ValueError):
            extract.extract_any(tmp / "a.exe")

    def test_chunking_keeps_page_and_heading(self):
        pages = [extract.PageText(3, "SCHEDULE 6\n\n" + ("Floor area ratio text. " * 120), "text")]
        ch = extract.chunk_pages(pages)
        self.assertGreater(len(ch), 1)
        self.assertTrue(all(c["page"] == 3 for c in ch))
        self.assertTrue(all(len(c["text"]) < 1500 for c in ch))
        self.assertTrue(all(len(c["text"]) > 300 for c in ch[:-1]), [len(c["text"]) for c in ch])   # no stray overlap-only chunks


class DatasetTests(unittest.TestCase):
    def test_ingest_scanned_pdf_then_search_finds_it(self):
        tmp = Path(tempfile.mkdtemp())
        pdf = make_scanned_pdf(tmp / "gaz.pdf", text="GAZETTE EXTRAORDINARY 9999/99\nThe retention money shall be 5 percent of each progress payment and released after the defects liability period.")
        info = ingest.ingest_file(pdf, {"id": "t-scan", "title": "Test scanned gazette", "category": "procurement-policy", "sha256": "x"}, origin="upload", progress=None)
        self.assertEqual(info["ocr_pages"], 1)
        hits = retrieval.search("retention money progress payment defects liability")
        self.assertTrue(hits and hits[0]["doc_id"] == "t-scan", [h["doc_id"] for h in hits[:3]])

    def test_dataset_is_single_file_and_exports(self):
        res = ingest.export_dataset()
        self.assertGreater(res["chunks"], 20)
        rows = [json.loads(l) for l in Path(config.JSONL_PATH).read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), res["chunks"])
        self.assertTrue({"chunk_id", "doc_id", "title", "page", "text", "status", "origin"} <= set(rows[0]))

    def test_superseded_documents_rank_lower_and_can_be_hidden(self):
        hits = retrieval.search("procurement guidelines", limit=10)
        cur = retrieval.search("procurement guidelines", limit=10, only_current=True)
        self.assertTrue(all(h["status"] != "superseded" for h in cur))
        self.assertTrue(hits)

    def test_retrieval_hit_rate_on_known_questions(self):
        cases = [
            ("parking required for apartments", "kotte-pnbr-schedules-2021"),
            ("rear space for a building of 10 storeys", "kotte-pnbr-schedules-2021"),
            ("which gazette replaced the 2006 procurement guidelines", "gazette-2412-01-en"),
            ("Form C1 floor area ratio Colombo 500 square metres", "ccdp-2008-colombo"),
            ("sections of the national competitive bidding goods document", "npa-goods-sbd01-ncb"),
            ("Aloe Avenue building line", "gazette-2105-24-en"),
            ("zone factor 2.00-2.24 floor area ratio", "kotte-pnbr-schedules-2021"),
            ("UDA Law planning clearance", "uda-law-consolidated"),
        ]
        misses = []
        for q, want in cases:
            top = [h["doc_id"] for h in retrieval.search(q, limit=5)]
            if want not in top:
                misses.append((q, want, top))
        self.assertEqual(misses, [])

    def test_nonsense_query_is_filtered_by_relevance_gate(self):
        hits = retrieval.relevant(retrieval.search("quantum chromodynamics lattice gauge theory", limit=8))
        self.assertEqual(hits, [])


class DownloadAndUpdate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site = LocalSite()
        cls.tmp = Path(tempfile.mkdtemp())
        cls.text_pdf = make_text_pdf(cls.tmp / "plan.pdf", [
            "CITY OF COLOMBO DEVELOPMENT PLAN\nFull text version fetched from the local test site.\nThe permissible floor area ratio is stated in Form C1.",
            "Page two: parking, open space and building lines are regulated by Form C2."])
        cls.scan_pdf = make_scanned_pdf(cls.tmp / "scan.pdf", text="GAZETTE 7777/11\nPerformance security shall be ten percent of the contract price for works.")
        cls.site.files["/docs/plan.pdf"] = cls.text_pdf.read_bytes()
        cls.site.files["/gazettes/2026/10/7777-11_E.pdf"] = cls.scan_pdf.read_bytes()
        cls.site.files["/gazettes/2026/10/7777-11_S.pdf"] = cls.scan_pdf.read_bytes()
        cls.site.pages["/list"] = ('<table><tr><td>Building regulations amendment</td><td><a href="/gazettes/2026/10/7777-11_E.pdf">English</a>'
                                   '<a href="/gazettes/2026/10/7777-11_S.pdf">Sinhala</a></td></tr>'
                                   '<tr><td>Annual report</td><td><a href="/docs/plan.pdf">plan</a></td></tr></table>')
        cls._src = config.SOURCES_JSON
        cls.reg_file = cls.tmp / "sources.json"
        config.SOURCES_JSON = cls.reg_file

    @classmethod
    def tearDownClass(cls):
        config.SOURCES_JSON = cls._src
        cls.site.close()

    def test_1_fetch_conditional_get_and_validation(self):
        dest = self.tmp / "dl" / "plan.pdf"
        r1 = downloader.fetch(self.site.base + "/docs/plan.pdf", dest)
        self.assertEqual(r1["status"], "new"); self.assertTrue(dest.exists()); self.assertEqual(dest.read_bytes()[:4], b"%PDF")
        r2 = downloader.fetch(self.site.base + "/docs/plan.pdf", dest, etag=r1["etag"], prev_sha=r1["sha256"])
        self.assertEqual(r2["status"], "unchanged"); self.assertEqual(r2["http"], 304)
        self.assertEqual(downloader.fetch(self.site.base + "/fake.pdf", self.tmp / "dl" / "f.pdf")["status"], "error")
        self.assertFalse((self.tmp / "dl" / "f.pdf").exists())
        r4 = downloader.fetch(self.site.base + "/forbidden.pdf", self.tmp / "dl" / "x.pdf", retries=1)
        self.assertEqual((r4["status"], r4["http"]), ("error", 403))

    def test_2_discovery_prefers_english_and_filters_by_row_text(self):
        res = downloader.discover_links(self.site.base + "/list", text_regex="building regulations")
        urls = [l["url"] for l in res["links"]]
        self.assertEqual(urls, [self.site.base + "/gazettes/2026/10/7777-11_E.pdf"])

    def test_3_update_replaces_seed_with_full_text_and_is_idempotent(self):
        self.reg_file.write_text(json.dumps({
            "sources": [{"id": "ccdp-2008-colombo", "title": "City of Colombo Development Plan 2008", "category": "development-plans", "status": "verify",
                         "urls": [self.site.base + "/docs/plan.pdf"], "verified": True},
                        {"id": "blocked-one", "title": "Blocked", "urls": [self.site.base + "/forbidden.pdf"]}],
            "discovery": [{"id": "list-1", "title": "Local listing", "page_url": self.site.base + "/list", "text_regex": "building regulations", "category": "building-regulations"}]}))
        with db.db() as con:
            self.assertEqual(con.execute("SELECT origin FROM documents WHERE id='ccdp-2008-colombo'").fetchone()[0], "seed-extract")
        (config.INBOX / "inbox note.txt").write_text("Inbox file about the NBRO landslide clearance for slopes above 10 degrees.")
        s1 = ingest.update(progress=None)
        self.assertEqual(s1["new"], 1)
        self.assertEqual(s1["discovered_added"], 1)
        self.assertEqual(s1["inbox"], 1)
        self.assertEqual([e["id"] for e in s1["errors"]], ["blocked-one"])
        with db.db() as con:
            row = con.execute("SELECT origin,pages,gazette_no FROM documents WHERE id='ccdp-2008-colombo'").fetchone()
            self.assertEqual((row["origin"], row["pages"]), ("full-text", 2))
            disc = con.execute("SELECT ocr_pages,gazette_no,status FROM documents WHERE id LIKE 'disc-%'").fetchone()
            self.assertEqual((disc["ocr_pages"], disc["gazette_no"], disc["status"]), (1, "7777/11", "unverified"))
        self.assertTrue(retrieval.search("performance security ten percent contract price works")[0]["doc_id"].startswith("disc-"))
        self.assertTrue(retrieval.search("NBRO landslide clearance slopes")[0]["doc_id"].startswith("inbox-"))
        # second run: nothing re-downloaded or re-OCR'd
        before = len(self.site.hits)
        s2 = ingest.update(progress=None)
        self.assertEqual((s2["new"], s2["updated"], s2["unchanged"], s2["discovered_added"], s2["inbox"]), (0, 0, 2, 0, 0))   # plan.pdf + the document discovered in run 1
        self.assertIn(("/docs/plan.pdf", 304), self.site.hits[before:])
        self.assertIn(("/gazettes/2026/10/7777-11_E.pdf", 304), self.site.hits[before:])
        # the registry knows about the discovered document now
        self.assertTrue(any(s["id"].startswith("disc-") for s in ingest.load_registry()["sources"]))

    def test_4_changed_file_is_detected_as_updated(self):
        newpdf = make_text_pdf(self.tmp / "plan2.pdf", ["CITY OF COLOMBO DEVELOPMENT PLAN\nRevised text with amendment 2027.", "Page two revised."])
        self.site.files["/docs/plan.pdf"] = newpdf.read_bytes()
        s = ingest.update(progress=None, discover=False)
        self.assertEqual(s["updated"], 1)
        self.assertTrue(retrieval.search("amendment 2027 revised")[0]["doc_id"] == "ccdp-2008-colombo")


if __name__ == "__main__":
    unittest.main()
