import json
import re

import pytest

from seo_agent import offline, tools as T

JOB = ("Looking for photorealistic exterior renders of a modern villa. We have a Revit model. "
       "Need 3 camera views, dusk lighting, landscaping and pool. Corona or V-Ray preferred. "
       "Deadline is 10 days. Budget $400-600. Can you also do one aerial view? What is your revision policy?")


def _md(task, **kw):
    return "\n\n".join(e["text"] for e in offline.run(task, seed=7, **kw) if e["type"] == "text")


@pytest.mark.parametrize("key", list(offline.SERVICES))
def test_every_niche_produces_valid_fiverr_gig(key):
    _, info = offline.fiverr_package(key, offline.parse_seller(""), offline.random.Random(1))
    assert info["title"].startswith("I will") and len(info["title"]) <= 80
    assert len(info["tags"]) == 5 and all(len(t) <= 20 for t in info["tags"])
    assert len(set(info["tags"])) == 5
    assert len(info["description"]) <= 1200
    assert info["score"] >= 85, info


@pytest.mark.parametrize("key", list(offline.SERVICES))
def test_every_niche_upwork_profile_valid(key):
    md = offline.upwork_profile(key, offline.parse_seller("4 years 3ds max corona"), offline.random.Random(1))
    title = md.split("**")[1]
    assert len(title) <= 70
    assert int(re.search(r"Score: (\d+)", md).group(1)) >= 85


def test_job_post_parsing():
    b = offline.parse_job_post(JOB)
    assert (b.property, b.style, b.lighting, b.source) == ("villa", "modern", "dusk", "Revit")
    assert b.quantity == (3, "views") and b.deadline == "10 days" and b.budget == "$400-600"
    assert len(b.questions) == 2


def test_proposal_is_specific_and_scores_high():
    md = _md("proposal", text=JOB, about="5 years 3ds max corona")
    proposal = md.split("```")[1]
    first = proposal.strip().splitlines()[0].lower()
    assert "modern villa" in first and "dusk" in first
    assert "into 3ds Max and render with Corona" in proposal
    assert "revision rounds per stage" in proposal          # auto-answered client question
    assert proposal.strip().endswith("?")
    assert json.loads(T.check_proposal(proposal, JOB))["score"] >= 85


def test_full_workflow_sections_and_pricing_level():
    md = _md("full", niche="3d floor plans", about="1 year sketchup")
    for h in ("Market & Keyword Analysis", "Fiverr Gig Optimization Package", "Requirements Questionnaire",
              "Pricing Strategy", "Upwork Winning Proposal Framework"):
        assert h in md
    assert "entry-level" in md


def test_audit_before_and_after():
    listing = ("Title: I will do best cheap 3d render\nTags: render, 3d, cheap\n"
               "Description: Contact me on whatsapp for cheap renders")
    md = _md("audit", text=listing, platform="fiverr")
    before = int(re.search(r"Score: (\d+)", md).group(1))
    after = int(re.findall(r"Score: (\d+)", md)[-1])
    assert before < 40 and after >= 85


def test_quantity_with_words_between():
    b = offline.parse_job_post("Need 5 interior renders of a scandinavian apartment, within 7 days.")
    assert b.quantity == (5, "views") and b.deadline == "7 days" and b.style == "scandinavian"
    assert offline.parse_job_post("Deadline 10 days, 3 photorealistic exterior views").quantity == (3, "views")
