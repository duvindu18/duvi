"""All site content in one place. Edit here, then run:  python3 _build/build.py

Written for a 3D visualization studio. Client and material fields are kept in
the data (for a later architectural practice) but are not shown on the pages.
Text in headlines may use *asterisks* to set a word in the light weight.
"""

SITE = {
    "name": "Studio Morfis",
    "full_name": "Studio Morfis",
    "descriptor": "3D Visualization Studio",
    "tagline": "Architectural images, films &amp; the slow making of light",
    "description": "Studio Morfis is an independent 3D visualization studio making images, films and walkthroughs of architecture before it is built.",
    "email": "hello@studiomorfis.com",
    "phone": "+45 33 12 40 08",
    "founded": 2011,
    "year": 2026,
    "nav": [("archive.html", "Index", "archive"), ("studio.html", "Studio", "studio"), ("contact.html", "Contact", "contact")],
    "social": [("https://instagram.com", "Instagram", "IG"), ("https://linkedin.com", "LinkedIn", "LI"), ("https://vimeo.com", "Vimeo", "VI")],
}

HOME = {
    "kicker": "Selected work 2020 — 2026",
    "headline": ["Buildings, seen", "*before* they", "are built."],
    "facts_label": "Services",
    "facts": "Stills, film, interactive tours",
    "chapter_word": "Works",
    "chapter_number": "/26",
    "chapter_text": "Six commissions across four countries: a house, a pavilion, a chapel, an archive and two places to live, all pictured before the first stone.",
    "marquee": "Selected work / 2020 — 2026 / Stills / Film / Interactive /",
    "end_text": "Every commission since 2011, built or still on paper, with notes on light, lens and time of day.",
}

WORKS = {
    "intro": "A register of every commission, built or still on paper. Hover a title to preview it; select to open the project.",
}

STUDIO = {
    "headline": ["A small studio for", "buildings that *don't*", "exist yet."],
    "paragraphs": [
        "Studio Morfis was founded in 2011 by Astrid Morfis. We are fourteen artists working with architects, developers and competition teams on a deliberately small number of commissions at a time.",
        "We make still images, films and interactive walkthroughs. The tools change; the questions stay the same: where the light comes from, how a material feels, and how a room will be lived in.",
    ],
    "figures": [
        ("studio-1.jpg", 1600, 2000, "The studio"),
        ("studio-2.jpg", 2000, 1334, "Lighting tests, winter"),
    ],
}

CONTACT_PAGE = {
    "headline": ["Begin with", "*a conversation.*"],
    "intro": "We take on a small number of commissions each month. Send drawings or a model, the views you need and your deadline, and we will reply with a proposal.",
}

# image tuple: (file, width, height, caption)
PROJECTS = [
    {
        "slug": "the-monolithic-void", "index": "01", "title": "The Monolithic Void",
        "typology": "Private Residence", "city": "Sintra", "country": "Portugal", "year": 2024,
        "status": "Delivered", "area": "412 m²", "client": "Private", "team": "A. Morfis, M. Sørensen, J. Pires",
        "lead": "Stills and a short film for a concrete house above the Atlantic, built around a single cut of light.",
        "narrative": [
            "The architects needed images of an idea most clients find hard to picture: a house made almost entirely of one material, with a single opening on its entrance façade.",
            "We modelled the board-formed concrete from the shuttering drawings, plank by plank, and spent most of the commission on one question: where the nine-metre slot of light falls at each hour of the day.",
            "The final set is eight stills and a ninety-second film that follows the blade of light from the hall to the dining table, from morning to dusk.",
        ],
        "materials": [("Board-formed concrete", "Pine shuttering, 120 mm boards", "#9a958d"), ("Honed basalt", "Floors and thresholds", "#2f2d2b"), ("Oiled oak", "Joinery and window frames", "#a88763")],
        "figures": [("monolith-1.jpg", 1600, 2000, "Entrance hall, the nine-metre light slot"), ("monolith-2.jpg", 1600, 2000, "Stair void, late afternoon"), ("monolith-3.jpg", 2000, 1334, "The house from the lower terrace")],
    },
    {
        "slug": "timber-pavilion", "index": "02", "title": "Timber Pavilion",
        "typology": "Cultural Pavilion", "city": "Vejle", "country": "Denmark", "year": 2023,
        "status": "Delivered", "area": "260 m²", "client": "Vejle Fjord Foundation", "team": "A. Morfis, L. Kragh, T. Ono",
        "lead": "Interior stills and a walkthrough film for a sixty-metre gallery of spruce fins beside a fjord.",
        "narrative": [
            "The pavilion is a single long room whose character comes from rhythm: two hundred and forty fins that open and close as you walk along it.",
            "Still images could not show that, so the centrepiece of the commission is a slow walkthrough film, timed to a visitor's pace, with the fjord light shifting through the fins.",
            "Six stills accompany the film. They were used in the planning application and later in the foundation's fundraising campaign.",
        ],
        "materials": [("Cross-laminated spruce", "Primary structure and fins", "#cfae86"), ("Douglas fir", "Floor boards, 220 mm widths", "#b0855c"), ("Lime plaster", "End walls, hand-trowelled", "#ece6db")],
        "figures": [("timber-1.jpg", 1600, 2000, "The gallery, looking east"), ("timber-2.jpg", 2000, 1334, "Reading room toward the fjord"), ("timber-3.jpg", 1600, 2000, "North elevation, fin rhythm")],
    },
    {
        "slug": "house-of-clay", "index": "03", "title": "House of Clay",
        "typology": "Rural Retreat", "city": "Évora", "country": "Portugal", "year": 2022,
        "status": "Delivered", "area": "188 m²", "client": "Private", "team": "A. Morfis, J. Pires",
        "lead": "A series of quiet interior images for a rammed-earth house on the Alentejo plain.",
        "narrative": [
            "Rammed earth is hard to render convincingly. Its layers, colour shifts and soft edges give away any shortcut.",
            "We photographed test walls on site with the builder and built the material from those references, so the images show the walls the house will actually have.",
            "The commission ended with five stills at different hours, from the cool blue of early morning to the warm light of late afternoon.",
        ],
        "materials": [("Rammed earth", "Site-excavated soil, 500 mm", "#b98d72"), ("Natural clay plaster", "Interior walls, unsealed", "#dcc2b0"), ("Terracotta", "Handmade floor tiles", "#9d5f45")],
        "figures": [("clay-1.jpg", 1600, 2000, "Living room, morning light on clay"), ("clay-2.jpg", 2000, 1334, "Approach across the plain"), ("clay-3.jpg", 1600, 2000, "Courtyard passage")],
    },
    {
        "slug": "basalt-archive", "index": "04", "title": "Basalt Archive",
        "typology": "Library &amp; Archive", "city": "Reykjavík", "country": "Iceland", "year": 2025,
        "status": "In production", "area": "3,400 m²", "client": "City of Reykjavík", "team": "A. Morfis, M. Sørensen, E. Gunnarsdóttir",
        "lead": "Competition and design-stage images for a public archive wrapped in a screen of basalt fins.",
        "narrative": [
            "The archive began as a competition entry. Our first image was made in nine days and helped the design team win.",
            "Since then we have followed the design through each stage, updating the façade study as the fins changed depth and spacing to suit the low northern sun.",
            "The final film and street-level stills are in production for the building's opening in 2027.",
        ],
        "materials": [("Cast basalt", "Façade fins, recycled aggregate", "#4c5253"), ("Polished concrete", "Reading hall floor", "#a5a9a8"), ("Birch plywood", "Shelving and carrels", "#d9c9a8")],
        "figures": [("basalt-1.jpg", 1600, 2000, "West façade, basalt screen"), ("basalt-2.jpg", 1600, 2000, "Stack corridor"), ("basalt-3.jpg", 2000, 1334, "Site study, Faxaflói bay")],
    },
    {
        "slug": "chapel-of-still-light", "index": "05", "title": "Chapel of Still Light",
        "typology": "Sacred Space", "city": "Ticino", "country": "Switzerland", "year": 2021,
        "status": "Delivered", "area": "96 m²", "client": "Parish of Valle Maggia", "team": "A. Morfis, R. Bianchi",
        "lead": "Two images and a year-long light study for a small stone chapel lit only from above.",
        "narrative": [
            "The brief was modest: one exterior and one interior image for the parish's fundraising leaflet.",
            "The interior became a study of its own. We tested the roof glazing in every month of the year to show how light would slide down the dry-laid stone, and the architects used the results to adjust the width of the glass band.",
        ],
        "materials": [("Maggia gneiss", "Dry-laid walls", "#b0aa9f"), ("White concrete", "Roof plate", "#e2dfd8"), ("Chestnut", "Benches and door", "#6f4e35")],
        "figures": [("chapel-1.jpg", 1600, 2000, "Light falling along the north wall"), ("chapel-2.jpg", 2000, 1334, "The perimeter glass band"), ("chapel-3.jpg", 1600, 2000, "Nave at dusk")],
    },
    {
        "slug": "courtyard-houses", "index": "06", "title": "Courtyard Houses",
        "typology": "Housing", "city": "Palma", "country": "Spain", "year": 2020,
        "status": "Delivered", "area": "2,150 m²", "client": "IBAVI Housing Institute", "team": "A. Morfis, L. Kragh, C. Ferrer",
        "lead": "Aerial and courtyard views for eighteen social homes arranged around walled gardens.",
        "narrative": [
            "Housing images are often bright, busy and generic. The brief asked for the opposite: calm views that show what daily life in a shaded courtyard would feel like.",
            "We produced one aerial of the whole carpet of courtyards and a set of eye-level views, each planted with the single tree its future residents will inherit.",
        ],
        "materials": [("Marès sandstone", "Load-bearing walls", "#d8cdb8"), ("Lime render", "Courtyard faces", "#efebe3"), ("Pine pergolas", "Shared lanes", "#b8946b")],
        "figures": [("courtyard-1.jpg", 1600, 2000, "A private courtyard"), ("courtyard-2.jpg", 2000, 1334, "Lane elevation"), ("courtyard-3.jpg", 1600, 2000, "Covered passage between houses")],
    },
]

PRINCIPLES = [
    ("Start from the drawings", "Every image is built from the architect's own plans, sections and models. We do not invent what has not been designed."),
    ("Light before detail", "We set the sun, the sky and the hour before placing a single object. Most of an image is decided by its light."),
    ("One image, one idea", "Each view should say one thing about the building. A few precise images serve a project better than many."),
    ("Honest materials", "Concrete, timber and stone keep their real grain, weathering and imperfection, so a design can be judged as it will be built."),
]

PEOPLE = [
    ("Astrid Morfis", "Founder, Creative Director"), ("Mads Sørensen", "Partner, Lighting"), ("Joana Pires", "Lead 3D Artist"),
    ("Lea Kragh", "Film &amp; Animation"), ("Takeshi Ono", "3D Artist"), ("Eva Gunnarsdóttir", "Technical Director"),
]

# Placeholder recognition: replace with the studio's real awards and press.
RECOGNITION = [
    ("2025", "Architectural Image of the Year — shortlist", "Basalt Archive"),
    ("2024", "Visualization Film Award — winner", "Timber Pavilion"),
    ("2023", "Interior Image Award — honourable mention", "House of Clay"),
    ("2022", "Competition Image Prize", "Basalt Archive"),
    ("2021", "Emerging Studio of the Year", "Studio Morfis"),
]

# Secondary contact columns on the Contact page: (label, email, note)
CONTACTS = [
    ("Press", "press@studiomorfis.com", "Images, films and project texts for publication."),
    ("Careers", "careers@studiomorfis.com", "Showreels and portfolios of up to 10 pages, as a single link or PDF."),
]
