"""Domain knowledge for architectural-visualization (arch viz) freelance SEO.

Platform limits below are the commonly documented values. Marketplaces change
them from time to time, so the agent is told to confirm with web search when a
limit matters (and the checker treats them as configurable).
"""

PLATFORM_RULES = {
    "fiverr": {
        "title_max": 80,
        "title_prefix": "I will",
        "tags_max": 5,
        "tag_chars_max": 20,
        "description_max": 1200,
        "notes": [
            "Gig title always starts with 'I will' - put the primary keyword right after it.",
            "Exactly 5 search tags; each tag up to 20 characters. Use phrases buyers type, not single generic words.",
            "Description up to 1200 characters. The first 2 lines show in previews: lead with the outcome + keyword.",
            "Gig images: 1280x769 recommended. Thumbnail text is not indexed but drives click-through (CTR), "
            "which affects ranking.",
            "Ranking signals: CTR from search, conversion rate, response time, order completion, on-time delivery, "
            "reviews, and repeat buyers. Keywords get you into results; performance keeps you there.",
            "Use 3 packages (Basic/Standard/Premium) with keyword-rich package names and clear deliverables "
            "(number of views, resolution, revisions).",
            "Add FAQs - their text adds relevant keyword coverage and answers objections.",
        ],
    },
    "upwork": {
        "title_max": 70,
        "skills_max": 15,
        "overview_max": 5000,
        "overview_visible": 200,
        "catalog_title_max": 75,
        "catalog_title_prefix": "You will get",
        "notes": [
            "Profile title is your headline in talent search: role + specialty + main software, e.g. "
            "'3D Architectural Visualizer | Photorealistic Rendering | 3ds Max Corona'.",
            "Only about the first 200 characters of the overview show before 'more' - make them a hook "
            "with your top keywords and the client outcome.",
            "Up to 15 skills. Pick the exact skill names Upwork offers (they are a fixed taxonomy).",
            "Specialized profiles let you target separate niches (e.g. exterior rendering vs. 3D animation).",
            "Project Catalog titles start with 'You will get' - same keyword-first rule as Fiverr.",
            "Ranking signals: Job Success Score, profile completeness, recent earnings, response rate, "
            "and how well proposals/profile match the job post text.",
            "Proposals: mirror the client's wording from the job post in the first 2 lines - that is "
            "the 'SEO' that matters for invitations and hires.",
        ],
    },
}

# Curated keyword bank. intent: buyer = ready-to-order phrases; research = early stage.
# competition is a rough qualitative estimate for marketplace search, not measured data.
KEYWORD_BANK = {
    "core": [
        ("architectural rendering", "buyer", "high"),
        ("3d architectural visualization", "buyer", "high"),
        ("3d rendering", "buyer", "high"),
        ("architectural visualization", "buyer", "high"),
        ("photorealistic rendering", "buyer", "medium"),
        ("3d render", "buyer", "high"),
        ("archviz", "research", "medium"),
    ],
    "exterior": [
        ("exterior rendering", "buyer", "high"),
        ("3d exterior rendering", "buyer", "medium"),
        ("house rendering", "buyer", "medium"),
        ("building rendering", "buyer", "medium"),
        ("aerial rendering", "buyer", "low"),
        ("night rendering", "buyer", "low"),
        ("landscape rendering", "buyer", "medium"),
    ],
    "interior": [
        ("interior rendering", "buyer", "high"),
        ("3d interior design", "buyer", "high"),
        ("kitchen rendering", "buyer", "medium"),
        ("bathroom rendering", "buyer", "low"),
        ("living room render", "buyer", "low"),
        ("office interior render", "buyer", "low"),
    ],
    "real_estate": [
        ("real estate rendering", "buyer", "medium"),
        ("pre construction marketing", "buyer", "low"),
        ("property visualization", "buyer", "low"),
        ("virtual staging", "buyer", "high"),
        ("off plan rendering", "buyer", "low"),
        ("floor plan rendering", "buyer", "medium"),
        ("3d floor plan", "buyer", "high"),
    ],
    "animation_interactive": [
        ("3d walkthrough animation", "buyer", "medium"),
        ("architectural animation", "buyer", "medium"),
        ("360 virtual tour", "buyer", "medium"),
        ("flythrough animation", "buyer", "low"),
        ("unreal engine archviz", "buyer", "low"),
        ("vr architecture", "research", "low"),
    ],
    "software": [
        ("3ds max", "buyer", "high"),
        ("corona render", "buyer", "medium"),
        ("vray", "buyer", "high"),
        ("lumion", "buyer", "medium"),
        ("enscape", "buyer", "medium"),
        ("d5 render", "buyer", "low"),
        ("twinmotion", "buyer", "low"),
        ("sketchup", "buyer", "high"),
        ("revit", "buyer", "high"),
        ("blender", "buyer", "high"),
        ("unreal engine 5", "buyer", "medium"),
    ],
    "modelling": [
        ("3d modeling", "buyer", "high"),
        ("cad to 3d", "buyer", "low"),
        ("sketch to 3d", "buyer", "low"),
        ("revit modeling", "buyer", "medium"),
        ("bim modeling", "buyer", "medium"),
    ],
    "commercial_niches": [
        ("hotel rendering", "buyer", "low"),
        ("restaurant interior render", "buyer", "low"),
        ("retail store rendering", "buyer", "low"),
        ("villa rendering", "buyer", "low"),
        ("apartment rendering", "buyer", "low"),
        ("product and furniture rendering", "buyer", "medium"),
    ],
}

UPWORK_SKILL_SUGGESTIONS = [
    "3D Rendering", "Architectural Rendering", "3D Modeling", "Autodesk 3ds Max",
    "V-Ray", "Corona Renderer", "SketchUp", "Autodesk Revit", "Lumion",
    "Enscape", "Unreal Engine", "Blender", "Interior Design", "Exterior Design",
    "3D Animation", "Virtual Staging", "Adobe Photoshop", "Architectural Design",
]

# Words that waste title/tag space or trigger marketplace filters.
WEAK_WORDS = {
    "best", "cheap", "cheapest", "quality", "professional", "amazing", "awesome",
    "top", "expert", "high quality", "fast", "unique", "perfect", "#1", "guaranteed",
}
BANNED_CONTACT_PATTERNS = [
    r"@[\w.-]+\.\w+",          # email
    r"\b(whats\s?app|skype|telegram|gmail)\b",
    r"https?://",              # external links in description
    r"\+?\d[\d\s-]{8,}\d",     # phone numbers
]
