import json
import threading
import urllib.request

from seo_agent import offline, verify, web


def test_links_are_plain_search_urls():
    links = verify.search_links("3d floor plan")
    assert links["fiverr"] == "https://www.fiverr.com/search/gigs?query=3d+floor+plan"
    assert "upwork.com/nx/search/jobs/?q=3d+floor+plan" in links["upwork_jobs"]


def test_scoring_prefers_suggested_low_competition():
    niche = verify.score_keyword({"fiverr_results": 300, "fiverr_suggested": True})
    crowded = verify.score_keyword({"fiverr_results": 90000, "fiverr_suggested": False})
    assert niche["score"] > 70 > crowded["score"]
    assert crowded["advice"].startswith("Drop")
    assert verify.score_keyword({})["score"] is None
    up = verify.score_keyword({"upwork_jobs": 400, "upwork_talent": 2000})
    assert 0 < up["score"] <= 100


def test_verified_keywords_drive_tags_and_table():
    verify.add_keywords(["villa rendering", "aerial rendering"])
    verify.upsert_keyword("aerial rendering", {"fiverr_results": "250", "fiverr_suggested": True})
    verify.upsert_keyword("villa rendering", {"fiverr_results": "120,000", "fiverr_suggested": False})
    svc = offline.SERVICES["exterior"]
    tags = offline.fiverr_tags(svc, offline.random.Random(1), verify.verified_scores())
    assert tags[0] == "exterior rendering" and tags[1] == "aerial rendering"
    assert "villa rendering" not in tags            # checked and scored as weak
    table = offline.keyword_section("exterior", offline.random.Random(1))
    assert table.index("aerial rendering") < table.index("house rendering")
    assert "/100" in table and "real numbers you entered" in table


def test_stats_metrics_change_and_diagnosis():
    verify.add_stat({"date": "2026-10-01", "gig": "Exterior", "impressions": 800, "clicks": 4, "orders": 0,
                     "note": "new thumbnail"})
    verify.add_stat({"date": "2026-10-15", "gig": "Exterior", "impressions": 1200, "clicks": 30, "orders": 2})
    rows = verify.stat_rows()
    latest, first = rows[0], rows[1]
    assert first["ctr"] == 0.5 and "thumbnail" in first["diagnosis"]
    assert latest["ctr"] == 2.5 and latest["conversion"] == 6.67
    assert latest["change"]["impressions"] == 400 and latest["change"]["after_change"] == "new thumbnail"
    assert "few impressions" in verify._diagnose(40, 1, 0).lower()


def test_verify_api_round_trip():
    httpd = web.serve("127.0.0.1", 0)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def post(payload):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/verify", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    try:
        snap = post({"action": "load_niche", "niche": "3d floor plans"})
        assert any(k["keyword"] == "3d floor plan" for k in snap["keywords"])
        snap = post({"action": "update", "keyword": "3d floor plan",
                     "fields": {"fiverr_results": 500, "fiverr_suggested": True}})
        assert snap["keywords"][0]["keyword"] == "3d floor plan" and snap["keywords"][0]["score"]
        snap = post({"action": "add_stat", "fields": {"gig": "Plans", "impressions": 50, "clicks": 1}})
        assert len(snap["stats"]) == 1
        snap = post({"action": "delete_stat", "id": snap["stats"][0]["id"]})
        assert snap["stats"] == []
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/verify") as r:
            assert "keywords" in json.loads(r.read())
    finally:
        httpd.shutdown()
