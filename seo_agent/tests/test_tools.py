import json

from seo_agent import tools as T


def test_fiverr_audit_flags_problems():
    r = json.loads(T.audit_listing(
        "fiverr", "Best cheap 3d rendering",
        "Contact me on whatsapp", ["render", "3d", "cheap"], ["exterior rendering"]))
    text = " ".join(r["issues"])
    assert r["score"] < 50
    assert "I will" in text and "filler" in text and "exactly 5 tags" in text.lower()
    assert "contact details" in text


def test_good_fiverr_gig_scores_high():
    desc = ("Need photorealistic exterior rendering for your house or villa? I create 3D exterior "
            "rendering in 3ds Max and Corona for architects, builders and real estate marketing. "
            "You get high resolution images, day or night lighting, landscaping and 2 revisions. "
            "Send your CAD, sketch or SketchUp/Revit model and I will turn it into realistic renders. "
            "Packages include 1, 3 or 5 camera views with 4K output and the source file in Premium. "
            "Turnaround from 2 days. Message me before ordering with your plans and deadline.")
    r = json.loads(T.audit_listing(
        "fiverr", "I will do photorealistic 3d exterior rendering for house and villa",
        desc, ["exterior rendering", "3d rendering", "house rendering", "villa rendering",
               "architectural render"], ["exterior rendering", "3d exterior rendering"]))
    assert r["score"] >= 85, r


def test_upwork_hook_check():
    r = json.loads(T.audit_listing("upwork", "3D Architectural Visualizer | Rendering",
                                   "Hello I am a person. " * 30, ["3D Rendering"],
                                   ["architectural rendering"]))
    assert any("200" in i for i in r["issues"])


def test_keywords_and_report(tmp_path, monkeypatch):
    data = json.loads(T.keyword_ideas("interior", "kitchen rendering"))
    assert "interior" in data and data["long_tail_from_seed"]
    monkeypatch.setattr(T, "REPORTS_DIR", tmp_path)
    assert "Saved" in T.save_report("../evil name", "# hi")
    assert len(list(tmp_path.glob("*.md"))) == 1


def test_fiverr_slug_and_first_150_words():
    desc = ("word " * 160) + "exterior rendering. Message me to order."
    r = json.loads(T.audit_listing("fiverr", "I will create stunning visuals for your next big project",
                                   desc, ["a b", "c d", "e f", "g h", "i j"], ["exterior rendering"]))
    text = " ".join(r["issues"])
    assert "URL slug" in text and "first 150 words" in text


def test_proposal_checker():
    job = ("Need photorealistic exterior renders of a modern villa from Revit model. 3 camera views, "
           "dusk lighting, landscaping. Corona or V-Ray preferred. Deadline 10 days.")
    bad = json.loads(T.check_proposal("Dear Sir, I am an expert. I can do this job. Thanks.", job))
    assert bad["score"] < 60 and any("Generic opener" in i for i in bad["issues"])
    good = ("Your modern villa needs dusk exterior renders that keep the Revit design intent - I'd bring "
            "the Revit model into 3ds Max via Datasmith and light it with Corona.\n"
            "Plan for your 3 camera views: 1) clay renders of each view for your approval of framing, "
            "2) materials, landscaping and dusk lighting draft, 3) final photorealistic renders in 4K with "
            "post-production. Two revision rounds are included at each stage, so nothing is a surprise at "
            "the end, and your 10 days deadline is covered with 2 days of buffer. You keep full rights to the "
            "renders and receive layered files for your marketing team.\n"
            "Do you already have landscaping references, or should I propose two planting moods for the views?")
    g = json.loads(T.check_proposal(good, job))
    assert g["score"] >= 85, g
