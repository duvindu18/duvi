"""Built-in engine: generates the full ArchViz SEO workflow with no AI and no API key.

Everything here is deterministic templates + the curated knowledge in knowledge.py,
checked with the same auditors the AI agent uses (tools.audit_listing / check_proposal).
It runs offline and costs nothing. Each run picks among variations, so pressing
Generate again gives a different take.
"""

from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass, field
from typing import Iterator

from . import tools as T
from .knowledge import FIVERR_CATEGORY_CANDIDATES, UPWORK_SKILL_SUGGESTIONS

# --------------------------------------------------------------------------- services

SERVICES: dict[str, dict] = {
    "exterior": {
        "titles": ['do photorealistic 3d exterior rendering for house and villa', 'do 3d exterior rendering and architectural visualization', 'create realistic exterior rendering in {sw} for architects', 'do 3d exterior rendering for real estate and residential projects'],
        "noun": 'exterior renders',
        "label": "3D exterior rendering",
        "detect": ["exterior", "facade", "façade", "house render", "building render", "aerial", "landscape"],
        "primary": "exterior rendering",
        "secondary": ["3d exterior rendering", "architectural rendering", "house rendering", "villa rendering"],
        "long_tail": ["photorealistic exterior rendering", "3d house rendering", "modern villa rendering",
                      "dusk exterior render", "aerial rendering", "residential exterior render",
                      "exterior rendering lumion", "3ds max corona exterior"],
        "tags": ["exterior rendering", "3d rendering", "house rendering", "villa rendering",
                 "architectural render", "3d exterior", "building rendering", "aerial rendering"],
        "subjects": ["house and villa", "homes and buildings", "residential projects", "architects and builders"],
        "unit": "camera view",
        "category": 0,
        "software": ["3ds Max", "Corona Renderer", "Photoshop"],
        "audience": "architects, builders and real estate developers",
        "deliverables": ["Photorealistic exterior renders in up to 4K",
                         "Day, dusk or night lighting with real-sky HDRI",
                         "Landscaping, people and cars for scale and life",
                         "Post-production for marketing-ready images"],
        "packages": [
            ("1 Exterior View", "1 camera view, 2K, day lighting", 3, 2, 70),
            ("3 Views + Dusk", "3 camera views, 4K, day or dusk, landscaping", 5, 3, 180),
            ("5 Views + Aerial", "5 views incl. aerial, 4K, day + dusk, layered PSD", 7, 4, 380),
        ],
        "milestones": ["3D model + clay renders of each camera for framing approval",
                       "Materials, lighting and landscaping draft for comments",
                       "Final photorealistic renders with post-production"],
    },
    "interior": {
        "titles": ['do photorealistic 3d interior rendering for kitchen and living room', 'create realistic interior rendering in {sw} for designers', 'do 3d interior rendering and interior design visualization'],
        "noun": 'interior renders',
        "label": "3D interior rendering",
        "detect": ["interior", "kitchen", "bathroom", "living room", "bedroom", "office interior", "lobby"],
        "primary": "interior rendering",
        "secondary": ["3d interior rendering", "3d interior design", "kitchen rendering", "architectural rendering"],
        "long_tail": ["photorealistic interior rendering", "3d kitchen rendering", "living room render",
                      "bathroom 3d render", "interior design visualization", "corona interior render",
                      "3d interior design for real estate", "office interior rendering"],
        "tags": ["interior rendering", "3d interior design", "kitchen rendering", "3d rendering",
                 "interior design", "bathroom rendering", "3d interior", "living room render"],
        "subjects": ["kitchen, living room and bathroom", "homes and apartments", "interior designers"],
        "unit": "camera view",
        "category": 1,
        "software": ["3ds Max", "Corona Renderer", "Photoshop"],
        "audience": "interior designers, architects and furniture brands",
        "deliverables": ["Photorealistic interior renders in up to 4K",
                         "Accurate materials, finishes and furniture from your specs",
                         "Natural daylight and warm evening lighting moods",
                         "Post-production with color grading"],
        "packages": [
            ("1 Interior View", "1 camera view, 2K, one room", 3, 2, 60),
            ("3 Views, 1-2 Rooms", "3 camera views, 4K, up to 2 rooms", 5, 3, 160),
            ("5 Views + 360", "5 views + one 360° panorama, 4K, layered PSD", 7, 4, 340),
        ],
        "milestones": ["Room model + clay renders for camera and layout approval",
                       "Materials, furniture and lighting draft for comments",
                       "Final photorealistic renders with post-production"],
    },
    "floor_plan": {
        "titles": ['create a 3d floor plan rendering for real estate listings', 'convert 2d plan to furnished 3d floor plan for realtors', 'design 3d floor plan and isometric floor plan rendering'],
        "noun": '3D floor plans',
        "label": "3D floor plan rendering",
        "detect": ["floor plan", "floorplan", "site plan", "2d plan", "isometric"],
        "primary": "3d floor plan",
        "secondary": ["floor plan rendering", "3d floor plan design", "real estate floor plan"],
        "long_tail": ["3d floor plan for real estate", "furnished 3d floor plan", "isometric floor plan",
                      "2d to 3d floor plan", "floor plan rendering for listing", "apartment 3d floor plan"],
        "tags": ["3d floor plan", "floor plan rendering", "floor plan", "real estate plan",
                 "2d to 3d plan", "isometric plan", "3d floor plans"],
        "subjects": ["real estate listings", "apartments and houses", "realtors and developers"],
        "unit": "floor plan",
        "category": 3,
        "software": ["3ds Max", "Corona Renderer", "AutoCAD"],
        "audience": "realtors, developers and architects",
        "deliverables": ["Furnished 3D floor plan from your 2D plan or sketch",
                         "Top view plus optional isometric angle",
                         "Room labels, dimensions and branding on request",
                         "High-resolution JPG/PNG ready for listings"],
        "packages": [
            ("1 Plan up to 100 m²", "1 furnished 3D floor plan, top view", 2, 2, 35),
            ("1 Plan up to 250 m²", "1 furnished plan, top + isometric view", 3, 3, 75),
            ("Plan up to 400 m² + 2D", "top + 2 isometric views + 2D marketing plan", 4, 4, 140),
        ],
        "milestones": ["Clean 3D layout from the 2D plan for wall/room approval",
                       "Furniture, materials and colors draft",
                       "Final renders with labels and branding"],
    },
    "animation": {
        "titles": ['create 3d walkthrough animation for architecture and real estate', 'make a cinematic 3d walkthrough animation of your project', 'create architectural animation and 3d flythrough video'],
        "noun": 'a walkthrough animation',
        "label": "3D architectural animation",
        "detect": ["animation", "walkthrough", "flythrough", "fly through", "video", "cinematic"],
        "primary": "3d walkthrough animation",
        "secondary": ["architectural animation", "3d walkthrough", "flythrough animation"],
        "long_tail": ["architectural walkthrough video", "3d flythrough animation", "real estate 3d animation",
                      "exterior walkthrough animation", "lumion animation", "unreal engine walkthrough"],
        "tags": ["3d walkthrough", "3d animation", "archviz animation", "flythrough video",
                 "walkthrough video", "3d architecture"],
        "subjects": ["real estate and architecture", "property marketing", "architects and developers"],
        "unit": "seconds of animation",
        "category": 4,
        "software": ["3ds Max", "Corona Renderer", "After Effects"],
        "audience": "real estate developers, architects and marketing teams",
        "deliverables": ["Smooth cinematic camera paths through your project",
                         "1080p or 4K video with color grading",
                         "Music, titles and logo on request",
                         "Storyboard approval before rendering"],
        "packages": [
            ("15s Walkthrough", "15 seconds, 1080p, 2 camera shots", 7, 2, 250),
            ("30s Walkthrough 4K", "30 seconds, 4K, up to 5 shots, music", 10, 3, 480),
            ("60s Cinematic 4K", "60 seconds, 4K, up to 10 shots, music, titles, logo", 14, 3, 900),
        ],
        "milestones": ["Model + storyboard / camera-path preview for approval",
                       "Low-resolution draft animation for timing and comments",
                       "Final 4K render, color grading, music and titles"],
    },
    "virtual_tour": {
        "titles": ['create a 360 virtual tour of your interior or property', 'render 360 virtual tour panoramas for real estate'],
        "noun": '360° panoramas',
        "label": "360 virtual tour",
        "detect": ["360", "virtual tour", "panorama", "vr", "virtual reality"],
        "primary": "360 virtual tour",
        "secondary": ["360 rendering", "vr architecture", "virtual tour"],
        "long_tail": ["360 interior panorama", "real estate virtual tour", "vr architectural tour",
                      "360 degree rendering", "interactive virtual tour"],
        "tags": ["360 virtual tour", "360 rendering", "virtual tour", "vr tour", "360 panorama"],
        "subjects": ["real estate and interiors", "pre-construction sales", "developers and agents"],
        "unit": "360° panorama",
        "category": 0,
        "software": ["3ds Max", "Corona Renderer", "Pano2VR"],
        "audience": "developers, real estate agents and interior designers",
        "deliverables": ["Photorealistic 360° panoramas of your spaces",
                         "Linked tour with hotspots between rooms",
                         "Works on phone, desktop and VR headsets",
                         "Files ready to host on your site or tour platform"],
        "packages": [
            ("3 Panoramas", "3 × 360° panoramas, 6K equirectangular", 5, 2, 120),
            ("6 Panoramas + Tour", "6 panoramas linked as a tour with hotspots", 7, 3, 230),
            ("10 Panoramas + Branding", "10 panoramas, hotspots, floor plan map, logo", 10, 3, 420),
        ],
        "milestones": ["Model + camera positions for each panorama approved",
                       "Draft panoramas for material and lighting comments",
                       "Final panoramas and linked tour"],
    },
    "real_estate": {
        "titles": ['do real estate rendering for pre construction marketing', 'create photorealistic real estate rendering for developers', 'do 3d real estate rendering for off plan property sales'],
        "noun": 'marketing renders',
        "label": "real estate rendering",
        "detect": ["real estate", "realtor", "pre construction", "pre-construction", "off plan", "off-plan",
                   "property", "listing", "developer", "marketing"],
        "primary": "real estate rendering",
        "secondary": ["3d rendering", "exterior rendering", "property visualization"],
        "long_tail": ["pre construction rendering", "off plan property render", "real estate 3d render",
                      "property marketing render", "new development rendering"],
        "tags": ["real estate render", "3d rendering", "exterior rendering", "property render",
                 "presales render", "architectural render"],
        "subjects": ["pre-construction marketing", "new developments", "property listings"],
        "unit": "camera view",
        "category": 0,
        "software": ["3ds Max", "Corona Renderer", "Photoshop"],
        "audience": "real estate developers, agents and prop-tech firms",
        "deliverables": ["Marketing-grade renders that sell before construction",
                         "Exterior and interior views from plans or BIM",
                         "Lifestyle staging, people and golden-hour lighting",
                         "Formats ready for brochures, billboards and listings"],
        "packages": [
            ("1 Marketing View", "1 exterior or interior view, 3K", 4, 2, 90),
            ("3 Marketing Views", "3 views, 4K, lifestyle staging", 6, 3, 240),
            ("6 Views Campaign Set", "6 views incl. aerial + amenity, 6K, PSD", 9, 4, 520),
        ],
        "milestones": ["Model + clay renders of each camera for framing approval",
                       "Materials, staging and lighting draft",
                       "Final marketing renders with post-production"],
    },
    "unreal": {
        "titles": ['create unreal engine 5 archviz walkthrough and real time render', 'make unreal engine 5 architectural visualization in real time'],
        "noun": 'a real-time Unreal Engine 5 walkthrough',
        "label": "Unreal Engine 5 real-time archviz",
        "detect": ["unreal", "ue5", "real-time", "realtime", "interactive", "twinmotion"],
        "primary": "unreal engine 5",
        "secondary": ["unreal engine archviz", "real time rendering", "interactive walkthrough"],
        "long_tail": ["unreal engine 5 archviz", "ue5 architectural walkthrough", "real time 3d visualization",
                      "interactive architectural walkthrough", "unreal engine real estate"],
        "tags": ["unreal engine 5", "unreal archviz", "real time render", "3d walkthrough", "ue5 archviz"],
        "subjects": ["real-time architecture", "interactive property sales", "architects and developers"],
        "unit": "real-time scene",
        "category": 4,
        "software": ["Unreal Engine 5", "Datasmith", "3ds Max"],
        "audience": "developers, architects and prop-tech firms",
        "deliverables": ["Real-time Unreal Engine 5 scene with Lumen lighting",
                         "Cinematic video rendered from the real-time scene",
                         "Optional interactive walkthrough (Windows .exe)",
                         "Revit / 3ds Max to Unreal via Datasmith"],
        "packages": [
            ("20s Real-Time Video", "20 seconds, 1080p, from your model", 7, 2, 300),
            ("45s Cinematic 4K", "45 seconds, 4K, up to 6 shots", 10, 3, 600),
            ("Interactive Walkthrough", "packaged interactive app + 30s video", 18, 3, 1200),
        ],
        "milestones": ["Datasmith import + scene setup preview",
                       "Materials, lighting and camera draft",
                       "Final video / packaged interactive build"],
    },
    "modeling": {
        "titles": ['do 3d modeling of your building from cad or sketch', 'do revit modeling and 3d architectural modeling from plans', 'convert cad to 3d model for rendering or bim'],
        "noun": 'an accurate 3D model',
        "label": "3D architectural modeling",
        "detect": ["modeling", "modelling", "revit", "bim", "cad to 3d", "sketch to 3d", "sketchup model"],
        "primary": "3d modeling",
        "secondary": ["revit modeling", "bim modeling", "cad to 3d"],
        "long_tail": ["architectural 3d modeling", "cad to 3d model", "revit bim modeling",
                      "sketchup 3d modeling", "2d plan to 3d model"],
        "tags": ["3d modeling", "revit modeling", "bim modeling", "cad to 3d", "sketchup model"],
        "subjects": ["architects and designers", "buildings and interiors", "render-ready projects"],
        "unit": "model",
        "category": 3,
        "software": ["Revit", "3ds Max", "SketchUp"],
        "audience": "architects, engineers and designers",
        "deliverables": ["Clean, accurate 3D model from CAD, PDF or sketches",
                         "Organized layers / families, ready for rendering or BIM",
                         "Native files plus FBX/OBJ exports",
                         "Clay preview images for checking"],
        "packages": [
            ("Model up to 150 m²", "simple building or interior model", 3, 2, 60),
            ("Model up to 400 m²", "detailed model, materials assigned", 5, 3, 140),
            ("Complex Model", "complex building, render-ready, families/assets", 8, 3, 280),
        ],
        "milestones": ["Massing model for proportions approval",
                       "Detailed model draft for comments",
                       "Final cleaned model and exports"],
    },
}
DEFAULT_SERVICE = "exterior"

SOFTWARE = {
    "3ds max": "3ds Max", "3dsmax": "3ds Max", "corona": "Corona Renderer", "v-ray": "V-Ray", "vray": "V-Ray",
    "lumion": "Lumion", "enscape": "Enscape", "d5": "D5 Render", "twinmotion": "Twinmotion",
    "sketchup": "SketchUp", "revit": "Revit", "blender": "Blender", "unreal": "Unreal Engine 5",
    "ue5": "Unreal Engine 5", "rhino": "Rhino", "archicad": "Archicad", "autocad": "AutoCAD",
    "photoshop": "Photoshop", "after effects": "After Effects", "cinema 4d": "Cinema 4D", "c4d": "Cinema 4D",
    "datasmith": "Datasmith", "forest pack": "Forest Pack", "railclone": "RailClone",
}
PROPERTY_WORDS = ["villa", "house", "home", "apartment", "condo", "townhouse", "tower", "office", "hotel",
                  "restaurant", "retail", "store", "kitchen", "bathroom", "living room", "bedroom", "lobby",
                  "warehouse", "school", "hospital", "resort", "residential building", "mixed-use", "cabin"]
STYLE_WORDS = ["modern", "contemporary", "minimalist", "scandinavian", "industrial", "luxury", "classic",
               "mediterranean", "tropical", "brutalist", "japandi", "farmhouse", "mid-century", "rustic"]
LIGHTING_WORDS = ["dusk", "night", "sunset", "golden hour", "daylight", "day", "evening", "morning", "overcast"]
SOURCE_WORDS = {"revit": "Revit", "sketchup": "SketchUp", "autocad": "AutoCAD", "cad": "CAD", "dwg": "DWG",
                "pdf": "PDF", "archicad": "Archicad", "rhino": "Rhino", "sketch": "sketch", "3ds max": "3ds Max",
                "ifc": "IFC/BIM", "bim": "BIM"}
UNIT_PATTERNS = [
    (r"(\d+)\s*(?:[a-z-]+\s+){0,2}?(?:views?|angles?|renders?|renderings?|images?|shots?)\b", "views"),
    (r"(\d+)\s*(?:sec(?:ond)?s?|s)\b(?:\s*(?:animation|video|walkthrough))?", "seconds"),
    (r"(\d+)\s*(?:panoramas?|360s?)", "panoramas"),
    (r"(\d+)\s*(?:floor\s*plans?|plans?)", "plans"),
]

HOSTS = ["3ds Max", "Blender", "Cinema 4D", "SketchUp", "Rhino", "Revit"]
RENDERERS = ["Corona Renderer", "V-Ray", "Lumion", "Enscape", "D5 Render", "Twinmotion", "Unreal Engine 5"]
STANDALONE = {"Lumion", "Enscape", "D5 Render", "Twinmotion", "Unreal Engine 5"}

LEVELS = {"entry": 0.6, "mid": 1.0, "pro": 1.8}


@dataclass
class Seller:
    software: list[str] = field(default_factory=list)
    years: int | None = None
    level: str = "mid"
    assumed_level: bool = True


@dataclass
class Brief:
    """What we could read out of a job post."""
    property: str | None = None
    style: str | None = None
    lighting: str | None = None
    source: str | None = None
    software: list[str] = field(default_factory=list)
    quantity: tuple[int, str] | None = None
    deadline: str | None = None
    budget: str | None = None
    questions: list[str] = field(default_factory=list)
    service: str = DEFAULT_SERVICE


# --------------------------------------------------------------------------- parsing

def detect_service(*texts: str) -> str:
    blob = " ".join(t.lower() for t in texts if t)
    best, best_hits = DEFAULT_SERVICE, 0
    for key, svc in SERVICES.items():
        hits = sum(blob.count(w) for w in svc["detect"])
        if hits > best_hits:
            best, best_hits = key, hits
    return best


def detect_software(text: str) -> list[str]:
    t = text.lower()
    found: list[str] = []
    for needle, name in SOFTWARE.items():
        if re.search(rf"(?<![a-z]){re.escape(needle)}(?![a-z])", t) and name not in found:
            found.append(name)
    return found


def parse_seller(about: str) -> Seller:
    s = Seller(software=detect_software(about))
    m = re.search(r"(\d+)\s*\+?\s*(?:years?|yrs?)", about.lower())
    if m:
        s.years = int(m.group(1))
        s.level = "entry" if s.years < 2 else "mid" if s.years < 6 else "pro"
        s.assumed_level = False
    for word, level in (("beginner", "entry"), ("new seller", "entry"), ("junior", "entry"),
                        ("senior", "pro"), ("expert", "pro"), ("premium", "pro"), ("mid-level", "mid"),
                        ("mid level", "mid")):
        if word in about.lower():
            s.level, s.assumed_level = level, False
    return s


def _first(words: list[str], text: str) -> str | None:
    t = text.lower()
    hits = [(t.find(w), w) for w in words if re.search(rf"(?<![a-z]){re.escape(w)}(?![a-z])", t)]
    return min(hits)[1] if hits else None


def parse_job_post(text: str) -> Brief:
    b = Brief()
    t = text.lower()
    b.property = _first(PROPERTY_WORDS, text)
    b.style = _first(STYLE_WORDS, text)
    b.lighting = _first(LIGHTING_WORDS, text)
    src = _first(list(SOURCE_WORDS), text)
    b.source = SOURCE_WORDS[src] if src else None
    b.software = detect_software(text)
    for pat, unit in UNIT_PATTERNS:
        m = re.search(pat, t)
        if m and 0 < int(m.group(1)) < 500:
            b.quantity = (int(m.group(1)), unit)
            break
    m = re.search(r"(?:deadline|within|in|by|due)\s*(?:of|is|:)?\s*(\d+\s*(?:business\s*)?(?:days?|weeks?|hours?))", t)
    if m:
        b.deadline = m.group(1)
    else:
        m = re.search(r"\b(asap|urgent|this week|next week|by (?:monday|tuesday|wednesday|thursday|friday|"
                      r"saturday|sunday|end of (?:the )?(?:week|month)))\b", t)
        b.deadline = m.group(1) if m else None
    m = re.search(r"(\$\s?\d[\d,]*(?:\s*-\s*\$?\s?\d[\d,]*)?|\d[\d,]*\s*(?:usd|eur|gbp))", t)
    b.budget = m.group(1) if m else None
    b.questions = [q.strip() for q in re.findall(r"[^.?!\n]*\?", text) if len(q.strip()) > 8][:5]
    b.service = detect_service(text)
    return b


# --------------------------------------------------------------------------- helpers

def _stack(seller: Seller, svc: dict, brief: Brief | None = None) -> list[str]:
    stack: list[str] = []
    for name in (brief.software if brief else []) + seller.software + svc["software"]:
        if name not in stack:
            stack.append(name)
    return stack[:4]


def _pipeline(source: str | None, seller: Seller, brief: Brief, svc: dict) -> str:
    """'I'll bring your Revit model into 3ds Max and render with Corona' - host and renderer kept apart."""
    pool = brief.software + seller.software + svc["software"]
    renderer = next((r for r in brief.software if r in RENDERERS and r in seller.software), None) \
        or next((r for r in brief.software if r in RENDERERS), None) \
        or next((r for r in seller.software if r in RENDERERS), None) \
        or next((r for r in svc["software"] if r in RENDERERS), "Corona Renderer")
    src = f"the {source} model" if source else "your model or drawings"
    if renderer in STANDALONE:
        return f"I'll bring {src} into {renderer} and build the final scene there."
    host = next((h for h in seller.software + svc["software"] if h in HOSTS and h != source), "3ds Max")
    return f"I'll bring {src} into {host} and render with {renderer}."


def _answer(question: str, svc: dict, seller: Seller, brief: Brief) -> str:
    q = question.lower()
    revs = svc["packages"][1][3]
    if "revision" in q:
        return (f"{revs} revision rounds per stage are included (camera, materials, lighting, props). "
                "Design changes after approval are quoted separately.")
    if any(w in q for w in ("aerial", "extra view", "additional view", "one more", "also do")):
        return "Yes - it's one more camera on the same model, so I can add it for [price]."
    if any(w in q for w in ("how long", "timeline", "turnaround", "deadline", "when can")):
        return f"{brief.deadline or '[N] days'} works, with clay previews in the first few days."
    if any(w in q for w in ("portfolio", "sample", "examples", "similar work", "previous work")):
        return "I've attached [2-3] similar projects - [describe the closest one]."
    if any(w in q for w in ("price", "cost", "rate", "budget", "quote")):
        return "[your fixed price] for the scope above, split across the 3 milestones."
    if any(w in q for w in ("software", "program", "which tool", "use")):
        return ", ".join(_stack(seller, svc, brief)) + "."
    return "[your answer]"


def _price(base: int, level: str) -> str:
    mid = base * LEVELS[level]
    lo, hi = mid * 0.85, mid * 1.2
    r = 5 if mid < 200 else 10 if mid < 600 else 50
    return f"${int(round(lo / r) * r)}–{int(round(hi / r) * r)}"


def _score(js: str) -> dict:
    return json.loads(js)


def _short_sw(stack: list[str]) -> str:
    names = [s.replace(" Renderer", "").replace(" Render", "").replace("Unreal Engine 5", "UE5") for s in stack[:2]]
    return " + ".join(names)


# --------------------------------------------------------------------------- Fiverr

def fiverr_titles(svc: dict, stack: list[str], rng: random.Random) -> list[str]:
    sw = _short_sw(stack).lower().replace(" + ", " and ") or "3ds max"
    out = []
    for body in svc["titles"]:
        t = "I will " + body.format(sw=sw)
        if len(t) <= 80 and t not in out:
            out.append(t)
    rng.shuffle(out)
    return out


def _verified() -> dict[str, int]:
    try:
        from .verify import verified_scores
        return verified_scores()
    except Exception:  # verification data is optional - never break generation
        return {}


def fiverr_tags(svc: dict, rng: random.Random, verified: dict[str, int] | None = None) -> list[str]:
    """5 tags. Keywords the seller checked in the Verify panel are ranked by their real score;
    weak checked ones (score < 40) are skipped; unchecked ones fill the remaining slots."""
    verified = verified or {}
    pool: list[str] = []
    for t in svc["tags"] + svc["secondary"] + svc["long_tail"]:
        if len(t) <= 20 and t not in pool:
            pool.append(t)
    first = [svc["primary"]] if len(svc["primary"]) <= 20 else []
    checked = sorted((t for t in pool if t in verified and verified[t] >= 40 and t not in first),
                     key=lambda t: -verified[t])
    unchecked = [t for t in svc["tags"] if len(t) <= 20 and t not in verified and t not in first]
    head, tail = unchecked[:3], unchecked[3:]
    rng.shuffle(tail)
    uniq: list[str] = []
    for t in first + checked + head + tail:
        if t not in uniq:
            uniq.append(t)
    return uniq[:5]


def fiverr_description(svc: dict, stack: list[str], revisions: int, rng: random.Random) -> str:
    p = svc["primary"]
    opener = rng.choice([
        f"Need {p} that sells the design before it is built?",
        f"Looking for photorealistic {p} that win approvals and buyers?",
        f"Your project deserves {p} that look like photographs.",
    ])
    parts = [
        f"{opener} I create photorealistic {svc['label']} for {svc['audience']}, using {', '.join(stack)}.",
        "",
        "WHAT YOU GET",
        *[f"• {d}" for d in svc["deliverables"]],
        "",
        "IDEAL FOR: " + ", ".join(svc["secondary"]) + ".",
        "",
        "HOW IT WORKS (NO SURPRISES)",
        f"• Clay preview of every {svc['unit']} first - you approve before final rendering",
        f"• Up to {revisions} revision rounds within scope, delivered on time",
        "• I work from CAD, Revit, SketchUp, PDF plans or hand sketches",
        "",
        "Before ordering, message me with your plans, references and deadline so I can confirm scope "
        "and delivery date.",
    ]
    text = "\n".join(parts)
    # Fiverr limit is 1200 characters - drop optional lines until it fits.
    for drop in ("• I work from CAD, Revit, SketchUp, PDF plans or hand sketches", f"• {svc['deliverables'][-1]}"):
        if len(text) <= 1200:
            break
        text = text.replace(drop + "\n", "")
    return text[:1200]


def fiverr_package(svc_key: str, seller: Seller, rng: random.Random) -> tuple[str, dict]:
    svc = SERVICES[svc_key]
    stack = _stack(seller, svc)
    targets = [svc["primary"]] + svc["secondary"][:2]
    tags = fiverr_tags(svc, rng, _verified())
    best = None
    for title in fiverr_titles(svc, stack, rng):
        desc = fiverr_description(svc, stack, svc["packages"][1][3], rng)
        sc = _score(T.audit_listing("fiverr", title, desc, tags, targets))
        if best is None or sc["score"] > best[0]["score"]:
            best = (sc, title, desc)
    sc, title, desc = best
    alts = [t for t in fiverr_titles(svc, stack, rng) if t != title][:2]
    slug = T.slugify(title[len("I will "):])
    cat = FIVERR_CATEGORY_CANDIDATES[svc["category"]]

    rows = []
    for tier, (name, scope, days, revs, base) in zip(("Basic", "Standard", "Premium"), svc["packages"]):
        rows.append(f"| **{tier}** - {name} | {scope} | {days} days | {revs} | {_price(base, seller.level)} |")
    level_note = (f"Prices assume a **{seller.level}-level** seller"
                  + (" (no experience given - set your years in *About you* to adjust)." if seller.assumed_level
                     else f" ({seller.years} years)." if seller.years else "."))

    faqs = [
        ("What files do you need from me?",
         "Plans (CAD/DWG, PDF), elevations or a 3D model (Revit, SketchUp, 3ds Max), plus material and mood "
         "references. Sketches work too."),
        ("Can I see a draft before the final render?",
         f"Yes. You approve a clay preview of each {svc['unit']} before I render the final images."),
        ("What counts as a revision?",
         "Changes to camera, materials, lighting or props within the agreed design. Changing the "
         "architecture itself after approval is a new scope."),
        ("Do you offer rush delivery?", "Yes, as an extra - message me with your deadline first."),
        ("Who owns the images?", "You get full commercial rights to the final images on completion."),
    ]
    requirements = [
        "Upload your drawings or model (CAD/DWG, PDF plans, Revit, SketchUp, 3ds Max, IFC).",
        f"How many {svc['unit']}s do you need, and do you have preferred camera angles? (mark them on the plan)",
        "Material and finish references (photos, mood board, product links or codes).",
        "Lighting and mood: day, dusk, night, season, weather?",
        "Final resolution and aspect ratio (e.g. 4K 16:9, A3 print, Instagram 4:5).",
        "Where will the images be used (web, brochure, billboard, competition)?",
        "Your deadline, and is the date fixed?",
        "Anything that must NOT change (brand colors, approved design details)?",
    ]
    thumbs = [f"\"{svc['primary'].title()}\" + your best render, full-bleed, no clutter",
              f"Before/after split: clay model vs. final {svc['unit']}",
              f"Short promise: \"Photoreal in {svc['packages'][0][2]} days\" on a strong hero image"]

    md = [
        "## 2. Fiverr Gig Optimization Package",
        "### Gig Title",
        f"**{title}** ({len(title)}/80 chars)",
        "",
        "Alternatives: " + " · ".join(f"*{a}*" for a in alts) if alts else "",
        "### URL Slug",
        f"`fiverr.com/<username>/{slug}` - created from the title when the gig is first published and "
        "can't be edited later, so publish with the final title.",
        "### Category / Subcategory",
        f"{cat}",
        "",
        "*Fiverr reorganizes categories from time to time - pick the closest match shown in the gig editor.*",
        "### Search Tags (5)",
        ", ".join(f"`{t}`" for t in tags),
        "### Pricing Strategy",
        "| Package | Scope & deliverables | Delivery | Revisions | Price |",
        "|---|---|---|---|---|",
        *rows,
        "",
        level_note + " Standard is priced as the obvious choice; Premium anchors it. "
        "Extras: fast delivery (+30-50%), extra view/plan, source file, commercial print sizes.",
        "### Gig Description",
        "```",
        desc,
        "```",
        f"{len(desc)}/1200 characters.",
        "### FAQs",
        *[f"**{q}**  \n{a}\n" for q, a in faqs],
        "### Requirements Questionnaire",
        *[f"{i}. {q}" for i, q in enumerate(requirements, 1)],
        "### Gig Image / Thumbnail Ideas",
        *[f"- {t}" for t in thumbs],
        "### SEO Check",
        f"**Score: {sc['score']}/100**" + (" - " + "; ".join(sc["issues"]) if sc["issues"] else " - no issues found."),
    ]
    return "\n".join(l for l in md if l is not None), {"title": title, "tags": tags, "description": desc,
                                                       "score": sc["score"]}


# --------------------------------------------------------------------------- keywords

def keyword_section(svc_key: str, rng: random.Random, verified: dict[str, int] | None = None) -> str:
    svc = SERVICES[svc_key]
    verified = _verified() if verified is None else verified
    bank = json.loads(T.keyword_ideas("all"))
    comp = {k["keyword"]: k["competition"] for g, items in bank.items() if isinstance(items, list)
            for k in items if isinstance(k, dict)}
    kws = [svc["primary"]] + svc["secondary"] + svc["long_tail"]
    # Checked keywords first, best real score on top; the rest keep their built-in order.
    kws = sorted(kws, key=lambda k: (k not in verified, -verified.get(k, 0)))
    rows = []
    for kw in kws:
        c = comp.get(kw) or ("high" if len(kw.split()) <= 2 else "medium" if len(kw.split()) == 3 else "low")
        use = ("Title + tag" if kw == svc["primary"] else "Tag / description" if kw in svc["secondary"]
               else "Description / FAQ / package name")
        mine = f"**{verified[kw]}**/100" if kw in verified else "-"
        rows.append(f"| {kw} | {mine} | {c} | {use} |")
    n_checked = sum(1 for k in kws if k in verified)
    note = (f"*{n_checked} of {len(kws)} keywords use the real numbers you entered in the Verify tab "
            "(scores out of 100). The others are built-in estimates - check them in Verify to replace them.*"
            if n_checked else
            "*Competition levels are built-in estimates, not measured search volume. Open the **Verify** tab "
            "to check each keyword on Fiverr and Upwork and replace the estimates with real numbers.*")
    return "\n".join([
        "## 1. Market & Keyword Analysis",
        f"**Sub-niche:** {svc['label']}  \n**Primary keyword:** `{svc['primary']}`  \n"
        f"**Buyers:** {svc['audience']}",
        "",
        "| Keyword | Your check | Competition (estimate) | Where to use |",
        "|---|---|---|---|",
        *rows,
        "",
        "**Strategy:** put the primary keyword right after \"I will\" in the title and in the first sentence of "
        "the description; use the secondary phrases as tags; spread the long-tail phrases through the "
        "description, package names and FAQs. Long-tail phrases rank faster for new gigs.",
        "",
        note,
    ])


# --------------------------------------------------------------------------- Upwork proposal

def proposal_section(job_post: str, seller: Seller, svc_key: str | None, rng: random.Random) -> str:
    if not job_post.strip():
        return proposal_framework(svc_key or DEFAULT_SERVICE, seller)
    b = parse_job_post(job_post)
    svc = SERVICES[svc_key if svc_key and svc_key != DEFAULT_SERVICE else b.service]
    stack = _stack(seller, svc, b)
    subject = " ".join(x for x in (b.style, b.property) if x) or "project"
    light = f"{b.lighting} " if b.lighting else ""
    qty = ""
    if b.quantity:
        n, unit = b.quantity
        qty = f"{n} {'views' if unit == 'views' else unit}"
    source = f"the {b.source} " if b.source else "your "

    within = f" within {b.deadline}" if b.deadline else ""
    design = f"your {b.source} design" if b.source else "your design"
    hook = rng.choice([
        f"Your {subject} needs {light}{svc['noun']} built exactly to {design} - "
        f"here is how I'd deliver {qty or 'them'}{within}.",
        f"For your {subject}, I'd lock every camera with you on clay renders before any final {light}render "
        f"is made, so {qty or 'everything'} lands{within or ' on time'} with no surprises.",
    ]).replace("  ", " ")
    if svc["noun"].startswith(("a ", "an ")):
        hook = hook.replace("deliver them", "deliver it")

    pipeline = _pipeline(b.source, seller, b, svc)

    scope_bits = [x for x in (qty, b.style and f"{b.style} style", b.lighting and f"{b.lighting} lighting",
                              b.source and f"{b.source} source files", b.deadline and f"deadline {b.deadline}") if x]
    scope = ("Your brief as I read it: " + ", ".join(scope_bits) + ".") if scope_bits else ""

    ms = svc["milestones"]
    body = [
        hook,
        "",
        f"{pipeline} {scope}".strip(),
        "",
        "Plan:",
        *[f"{i}) {m}" for i, m in enumerate(ms, 1)],
        "",
        f"You approve each stage, so there are no surprises at the end. "
        f"{svc['packages'][1][3]} revision rounds are included and you get full rights to the final files.",
    ]
    if b.questions:
        body += ["", "Your questions:"] + [f"- {q} {_answer(q, svc, seller, b)}" for q in b.questions]

    if not b.source:
        cta = "Which format is your model or drawing set in - Revit, SketchUp, CAD or PDF?"
    elif not b.lighting and svc["unit"] == "camera view":
        cta = "Would you like day or dusk lighting for the hero view, or should I show you both on the first clay?"
    else:
        cta = "Do you already have reference images for materials and mood, or should I propose two options?"
    body += ["", cta]
    proposal = "\n".join(body)

    sc = _score(T.check_proposal(proposal, job_post))
    missing = []
    for issue in sc["issues"]:
        m = re.search(r"Missing: \[(.*)\]", issue)
        if m:
            missing = [w.strip(" '\"") for w in m.group(1).split(",") if w.strip(" '\"")]
    if missing:
        extra = ", ".join(missing[:5])
        proposal = proposal.replace("\n\n" + cta, f"\n\nAlso covered from your post: {extra}.\n\n{cta}")
        sc = _score(T.check_proposal(proposal, job_post))

    found = [f"**Property:** {b.property or '-'}", f"**Style:** {b.style or '-'}",
             f"**Lighting:** {b.lighting or '-'}", f"**Source files:** {b.source or '-'}",
             f"**Quantity:** {qty or '-'}", f"**Software mentioned:** {', '.join(b.software) or '-'}",
             f"**Deadline:** {b.deadline or '-'}", f"**Budget:** {b.budget or '-'}"]
    milestone_rows = [f"| {i} | {m} | {pct}% |" for i, (m, pct) in enumerate(zip(ms, (30, 30, 40)), 1)]
    return "\n".join([
        "## 3. Upwork Winning Proposal",
        "### Job Post Breakdown",
        " · ".join(found),
        "",
        *(["**Client questions to answer:** " + " / ".join(b.questions)] if b.questions else []),
        "### Proposal (ready to paste)",
        "```",
        proposal,
        "```",
        "### Milestone Plan",
        "| # | Milestone | Payment |",
        "|---|---|---|",
        *milestone_rows,
        "### Strategy Notes",
        "- **Hook:** names the client's own project details in the first line - the only part shown in "
        "the proposal preview.",
        "- **Risk reduction:** approval at every stage plus a defined revision policy answers the client's "
        "biggest fear (endless revisions, renders that don't match the design).",
        "- **CTA:** one easy question to start a chat. Replies get you into the client's messages faster.",
        "- Attach 2-3 portfolio images that match the style and lighting the client asked for.",
        "- Replace every **[bracketed]** placeholder before sending.",
        "### Proposal Check",
        f"**Score: {sc['score']}/100** ({sc['word_count']} words)" +
        (" - " + "; ".join(sc["issues"]) if sc["issues"] else " - no issues found."),
    ])


def proposal_framework(svc_key: str, seller: Seller) -> str:
    svc = SERVICES[svc_key]
    stack = _stack(seller, svc)
    return "\n".join([
        "## 3. Upwork Winning Proposal Framework",
        "Paste a job post into the box and choose **Upwork proposal** to get a fully written proposal. "
        "Until then, use this framework:",
        "```",
        "[HOOK - 1 line, shown in preview] Your [style] [property] needs [lighting] [service] that keep the "
        "[source file] design intent exact - here's how I'd deliver [quantity] by [deadline].",
        "",
        f"[PIPELINE] I'll bring your [Revit/SketchUp/CAD] model into {stack[0]} and render with "
        f"{stack[1] if len(stack) > 1 else stack[0]}.",
        "",
        "Plan:",
        *[f"{i}) {m}" for i, m in enumerate(svc["milestones"], 1)],
        "",
        "[RISK REVERSAL] You approve each stage. [N] revision rounds included. Full rights to the final files.",
        "",
        "[CTA - one easy question] Which format is your model in - Revit, SketchUp or CAD?",
        "```",
        "**Rules:** never open with a greeting, your name or \"I read your job\"; reuse the client's own words; "
        "keep it to 120-250 words; end with a question.",
    ])


# --------------------------------------------------------------------------- Upwork profile

def upwork_profile(svc_key: str, seller: Seller, rng: random.Random) -> str:
    svc = SERVICES[svc_key]
    stack = _stack(seller, svc)
    sw = _short_sw(stack)
    prim = svc["primary"].title().replace("3D", "3D").replace("3d", "3D")
    cands = [f"{prim} | 3D Architectural Visualizer | {sw}",
             f"{prim} Artist | Photorealistic ArchViz | {sw}",
             f"{prim} & Architectural Rendering | {sw}",
             f"{prim} | ArchViz Specialist"]
    cands = [c.replace("3d", "3D") for c in cands if len(c) <= 70]
    ranked = sorted(cands, key=lambda t: -_score(T.audit_listing("upwork", t, "", [], [svc["primary"]]))["score"])
    titles = ranked or [f"{prim} | ArchViz"]
    title = titles[0]
    yrs = f"{seller.years}+ years" if seller.years else "Years"
    hook = (f"Photorealistic {svc['primary']} and architectural rendering for {svc['audience'].split(',')[0]} "
            f"- approved camera by camera, delivered on deadline.")[:200]
    overview = "\n".join([
        hook,
        "",
        f"{yrs} of {svc['label']} with {', '.join(stack)}. I turn plans, Revit/SketchUp models and sketches "
        "into images that win approvals, presales and competitions.",
        "",
        "What I deliver:",
        *[f"• {d}" for d in svc["deliverables"]],
        "",
        "How I work:",
        f"• Clay preview of every {svc['unit']} before final rendering",
        "• Clear milestones, fixed revision rounds, daily progress updates",
        "• Files organized and handed over, full commercial rights",
        "",
        "Also: " + ", ".join(SERVICES[k]["label"] for k in SERVICES if k != svc_key)[:220] + ".",
        "",
        "Message me with your plans and deadline - I'll reply with a scope and timeline within a few hours.",
    ])
    skills: list[str] = []
    for sw in stack:
        for cand in UPWORK_SKILL_SUGGESTIONS:
            if sw.split()[0].lower() in cand.lower() and cand not in skills:
                skills.append(cand)
    for cand in UPWORK_SKILL_SUGGESTIONS:
        if cand not in skills:
            skills.append(cand)
    skills = skills[:15]
    targets = [svc["primary"], "architectural rendering"]
    sc = _score(T.audit_listing("upwork", title, overview, skills, targets))
    offers = [f"You will get photorealistic {svc['primary']} of your {svc['subjects'][0]}"[:75],
              f"You will get {SERVICES['floor_plan']['primary']}s for your real estate listing"[:75],
              f"You will get a {SERVICES['animation']['primary']} of your project"[:75]]
    specialized = [SERVICES[k]["label"].title() for k in ("exterior", "interior", "animation", "floor_plan")
                   if k != svc_key][:3]
    return "\n".join([
        "## Upwork Profile",
        "### Profile Title",
        f"**{title}** ({len(title)}/70 chars)",
        "",
        "Alternatives: " + " · ".join(f"*{t}*" for t in titles[1:]) if len(titles) > 1 else "",
        "### Overview Hook (first ~200 characters shown in search)",
        f"> {hook}",
        "### Full Overview",
        "```",
        overview,
        "```",
        "### Skills (15)",
        ", ".join(f"`{s}`" for s in skills),
        "### Specialized Profiles",
        *[f"- {s}" for s in specialized],
        "### Project Catalog Offers",
        *[f"- {o}" for o in offers],
        "### Profile Check",
        f"**Score: {sc['score']}/100**" + (" - " + "; ".join(sc["issues"]) if sc["issues"] else " - no issues found."),
    ])


# --------------------------------------------------------------------------- audit

def parse_listing(text: str) -> tuple[str, list[str], str]:
    lines = [l.rstrip() for l in text.strip().splitlines()]
    title, tags, desc_lines = "", [], []
    for line in lines:
        low = line.lower().strip()
        m = re.match(r"^(title|gig title|headline)\s*[:\-]\s*(.*)$", low)
        if m:
            title = line.split(":", 1)[-1].strip() if ":" in line else line
            continue
        if re.match(r"^(tags|search tags|skills|keywords)\s*[:\-]", low):
            tags = [t.strip() for t in re.split(r"[,;|]", line.split(":", 1)[-1]) if t.strip()]
            continue
        if re.match(r"^(description|overview)\s*[:\-]\s*$", low):
            continue
        desc_lines.append(re.sub(r"^(description|overview)\s*[:\-]\s*", "", line, flags=re.I))
    if not title and desc_lines:
        title = desc_lines.pop(0).strip()
    return title, tags, "\n".join(desc_lines).strip()


def audit_section(text: str, platform: str, seller: Seller, rng: random.Random) -> tuple[str, str]:
    title, tags, desc = parse_listing(text)
    svc_key = detect_service(text)
    svc = SERVICES[svc_key]
    targets = [svc["primary"]] + svc["secondary"][:2]
    before = _score(T.audit_listing(platform, title, desc, tags, targets))
    md = ["## Listing Audit",
          f"Detected niche: **{svc['label']}** · target keyword: `{svc['primary']}`",
          "### Before",
          f"**Score: {before['score']}/100**",
          *[f"- {i}" for i in before["issues"]],
          *([f"- ✓ {w}" for w in before["wins"]]),
          "### After (rewritten below)"]
    return "\n".join(md), svc_key


# --------------------------------------------------------------------------- entry point

def run(task: str, niche: str = "", about: str = "", text: str = "", platform: str = "fiverr",
        seed: int | None = None) -> Iterator[dict]:
    """Yield the same UI events as the AI engines: tool steps, then Markdown text."""
    rng = random.Random(seed)
    seller = parse_seller(about)
    svc_key = detect_service(niche, about if not niche else "", text if task != "proposal" else "")
    if task == "proposal" and not niche:
        svc_key = DEFAULT_SERVICE
    header = (f"# {SERVICES[svc_key]['label'].title()} - SEO Package\n"
              "*Generated by the built-in engine (free, offline). Edit anything before you publish.*")

    if task == "audit":
        yield {"type": "tool", "name": "audit_listing", "detail": "scoring your current listing"}
        before_md, svc_key = audit_section(text, platform, seller, rng)
        yield {"type": "text", "text": before_md}
        yield {"type": "tool", "name": "keyword_ideas", "detail": SERVICES[svc_key]["label"]}
        if platform == "upwork":
            yield {"type": "text", "text": upwork_profile(svc_key, seller, rng)}
        else:
            md, _ = fiverr_package(svc_key, seller, rng)
            yield {"type": "text", "text": md}
        return

    yield {"type": "text", "text": header}
    if task in ("full", "fiverr", "keywords"):
        yield {"type": "tool", "name": "keyword_ideas", "detail": SERVICES[svc_key]["label"]}
        yield {"type": "text", "text": keyword_section(svc_key, rng)}
    if task in ("full", "fiverr"):
        yield {"type": "tool", "name": "audit_listing", "detail": "building and scoring the gig"}
        md, _ = fiverr_package(svc_key, seller, rng)
        yield {"type": "text", "text": md}
    if task == "keywords":
        svc = SERVICES[svc_key]
        stack = _stack(seller, svc)
        yield {"type": "text", "text": "\n".join([
            "## Title & Tag Recommendations",
            "**Fiverr titles:**", *[f"- {t}" for t in fiverr_titles(svc, stack, rng)[:3]],
            "", "**Fiverr tags:** " + ", ".join(f"`{t}`" for t in fiverr_tags(svc, rng, _verified())),
            "", f"**Upwork title:** 3D Architectural Visualizer | {svc['label'].title()} | {_short_sw(stack)}"])}
    if task == "upwork_profile":
        yield {"type": "tool", "name": "audit_listing", "detail": "building and scoring the profile"}
        yield {"type": "text", "text": upwork_profile(svc_key, seller, rng)}
    if task in ("full", "proposal"):
        yield {"type": "tool", "name": "check_proposal", "detail": "writing and scoring the proposal"}
        yield {"type": "text", "text": proposal_section(text if task == "proposal" else "", seller,
                                                        svc_key if niche else None, rng)}
    if seller.assumed_level and task in ("full", "fiverr"):
        yield {"type": "notice", "text": "Tip: add your years of experience and software in 'About you' "
                                         "to tailor prices and the tool stack."}
