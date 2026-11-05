"""All site content in one place. Edit here, then run:  python3 _build/build.py"""

SITE = {
    "name": "Halde",
    "full_name": "Halde Architecture Office",
    "tagline": "Architecture, landscape &amp; the slow making of rooms",
    "description": "Halde is an independent architecture office in Copenhagen working across houses, cultural buildings and public space.",
    "city": "Copenhagen",
    "time_zone": "Europe/Copenhagen",
    "coordinates": "55.68° N — 12.57° E",
    "email": "studio@halde.archi",
    "phone": "+45 33 12 40 08",
    "address": ["Strandgade 27B", "1401 Copenhagen K", "Denmark"],
    "founded": 2011,
    "year": 2026,
    "nav": [("archive.html", "Index", "archive"), ("studio.html", "Studio", "studio"), ("contact.html", "Contact", "contact")],
    "social": [("https://instagram.com", "Instagram", "IG"), ("https://linkedin.com", "LinkedIn", "LI"), ("https://are.na", "Are.na", "AR")],
}

# image tuple: (file, width, height, caption)
PROJECTS = [
    {
        "slug": "the-monolithic-void", "index": "01", "title": "The Monolithic Void",
        "typology": "Private Residence", "city": "Sintra", "country": "Portugal", "year": 2024,
        "status": "Completed", "area": "412 m²", "client": "Private", "team": "A. Halde, M. Sørensen, J. Pires",
        "lead": "A single mass of board-formed concrete, carved open by one vertical cut of light.",
        "narrative": [
            "Set into a granite slope above the Atlantic fog line, the house is conceived as one continuous casting. Its rooms are not built so much as subtracted, a sequence of hollows pressed into the hill.",
            "A single slot, nine metres tall and forty centimetres wide, is the only opening on the entrance façade. Over the course of a day its blade of light travels across the hall, the stair and the dining table, a slow sundial for the household.",
            "Every surface carries the grain of the pine boards it was cast against. Nothing is cladded, nothing is painted; the structure is the finish.",
        ],
        "materials": [("Board-formed concrete", "Pine shuttering, 120 mm boards", "#9a958d"), ("Honed basalt", "Floors and thresholds", "#2f2d2b"), ("Oiled oak", "Joinery and window frames", "#a88763")],
        "figures": [("monolith-1.jpg", 1600, 2000, "Entrance hall, the nine-metre light slot"), ("monolith-2.jpg", 1600, 2000, "Stair void, late afternoon"), ("monolith-3.jpg", 2000, 1334, "The house seen from the lower terrace")],
    },
    {
        "slug": "timber-pavilion", "index": "02", "title": "Timber Pavilion",
        "typology": "Cultural Pavilion", "city": "Vejle", "country": "Denmark", "year": 2023,
        "status": "Completed", "area": "260 m²", "client": "Vejle Fjord Foundation", "team": "A. Halde, L. Kragh, T. Ono",
        "lead": "Two hundred and forty spruce fins, tuned to the angle of the northern sun.",
        "narrative": [
            "The pavilion is a single gallery, sixty metres long, that runs along the fjord's edge. Its walls are a rhythm of vertical fins in cross-laminated spruce, spaced so that walking its length reads like turning the pages of a book.",
            "On the south the fins close into a solid wall; on the north they open toward the water, admitting only reflected light. Exhibitions are lit by the fjord itself.",
            "The building was prefabricated in eleven sections and assembled on site in nine days, sitting lightly on screw piles that leave the shoreline untouched.",
        ],
        "materials": [("Cross-laminated spruce", "Primary structure and fins", "#cfae86"), ("Douglas fir", "Floor boards, 220 mm widths", "#b0855c"), ("Lime plaster", "End walls, hand-trowelled", "#ece6db")],
        "figures": [("timber-1.jpg", 1600, 2000, "The gallery, looking east"), ("timber-2.jpg", 2000, 1334, "Reading room toward the fjord"), ("timber-3.jpg", 1600, 2000, "North elevation, fin rhythm")],
    },
    {
        "slug": "house-of-clay", "index": "03", "title": "House of Clay",
        "typology": "Rural Retreat", "city": "Évora", "country": "Portugal", "year": 2022,
        "status": "Completed", "area": "188 m²", "client": "Private", "team": "A. Halde, J. Pires",
        "lead": "Walls of rammed earth dug from the site itself, half a metre thick and cool at noon.",
        "narrative": [
            "In the Alentejo plain, summer heat is the defining condition. The house answers with mass: rammed-earth walls fifty centimetres thick, compacted in layers from soil excavated for the foundations.",
            "Openings are few and deep. Each frames a single element of the landscape: a cork oak, a well, the horizon line.",
            "Inside, natural clay plaster regulates humidity, and the floors are laid in handmade terracotta fired twenty kilometres away.",
        ],
        "materials": [("Rammed earth", "Site-excavated soil, 500 mm", "#b98d72"), ("Natural clay plaster", "Interior walls, unsealed", "#dcc2b0"), ("Terracotta", "Handmade floor tiles", "#9d5f45")],
        "figures": [("clay-1.jpg", 1600, 2000, "Living room, morning light on clay"), ("clay-2.jpg", 2000, 1334, "Approach across the plain"), ("clay-3.jpg", 1600, 2000, "Courtyard passage")],
    },
    {
        "slug": "basalt-archive", "index": "04", "title": "Basalt Archive",
        "typology": "Library &amp; Archive", "city": "Reykjavík", "country": "Iceland", "year": 2025,
        "status": "In progress", "area": "3,400 m²", "client": "City of Reykjavík", "team": "A. Halde, M. Sørensen, E. Gunnarsdóttir",
        "lead": "A municipal archive wrapped in a deep screen of cast basalt fins.",
        "narrative": [
            "The archive holds four centuries of civic records in a climate-stable core, surrounded by a public reading hall that rings the building at street level.",
            "The façade is a screen of cast basalt fins whose depth varies with orientation, deepest to the south and west, so that the reading hall is evenly lit through every season, including the low winter sun.",
            "Construction began in 2025; the building opens in the spring of 2027.",
        ],
        "materials": [("Cast basalt", "Façade fins, recycled aggregate", "#4c5253"), ("Polished concrete", "Reading hall floor", "#a5a9a8"), ("Birch plywood", "Shelving and carrels", "#d9c9a8")],
        "figures": [("basalt-1.jpg", 1600, 2000, "West façade, basalt screen"), ("basalt-2.jpg", 1600, 2000, "Stack corridor"), ("basalt-3.jpg", 2000, 1334, "Site study, Faxaflói bay")],
    },
    {
        "slug": "chapel-of-still-light", "index": "05", "title": "Chapel of Still Light",
        "typology": "Sacred Space", "city": "Ticino", "country": "Switzerland", "year": 2021,
        "status": "Completed", "area": "96 m²", "client": "Parish of Valle Maggia", "team": "A. Halde, R. Bianchi",
        "lead": "A room for forty people, lit only from above.",
        "narrative": [
            "A small chapel on a valley floor, replacing a nineteenth-century oratory lost to a flood. The brief asked only for a room for forty people and a bell.",
            "The walls are local gneiss, laid dry by two masons over one summer. The roof is a single concrete plate held clear of the walls by a band of glass, so that light falls down the stone surfaces rather than into the room.",
        ],
        "materials": [("Maggia gneiss", "Dry-laid walls", "#b0aa9f"), ("White concrete", "Roof plate", "#e2dfd8"), ("Chestnut", "Benches and door", "#6f4e35")],
        "figures": [("chapel-1.jpg", 1600, 2000, "Light falling along the north wall"), ("chapel-2.jpg", 2000, 1334, "The perimeter glass band"), ("chapel-3.jpg", 1600, 2000, "Nave at dusk")],
    },
    {
        "slug": "courtyard-houses", "index": "06", "title": "Courtyard Houses",
        "typology": "Housing", "city": "Palma", "country": "Spain", "year": 2020,
        "status": "Completed", "area": "2,150 m²", "client": "IBAVI Housing Institute", "team": "A. Halde, L. Kragh, C. Ferrer",
        "lead": "Eighteen social homes, each organised around its own walled garden.",
        "narrative": [
            "Eighteen affordable homes arranged as a low carpet of walled courtyards, a contemporary reading of the Mallorcan patio.",
            "Each house turns inward to a private garden planted with a single tree, and outward to a shared lane shaded by pergolas. Walls are built in marès sandstone quarried on the island.",
        ],
        "materials": [("Marès sandstone", "Load-bearing walls", "#d8cdb8"), ("Lime render", "Courtyard faces", "#efebe3"), ("Pine pergolas", "Shared lanes", "#b8946b")],
        "figures": [("courtyard-1.jpg", 1600, 2000, "A private courtyard"), ("courtyard-2.jpg", 2000, 1334, "Lane elevation"), ("courtyard-3.jpg", 1600, 2000, "Covered passage between houses")],
    },
]

PRINCIPLES = [
    ("Subtract before adding", "We begin by asking what a building can do without. Most of our best rooms are made by removing."),
    ("Let structure finish", "Where the structure can be the surface, we let it. Fewer layers age more honestly."),
    ("Draw with light", "Every plan is also a drawing of the sun's path. Openings are placed for an hour, not an elevation."),
    ("Build near", "Materials are sourced as close to site as practical: earth from the excavation, stone from the valley."),
]

PEOPLE = [
    ("Astrid Halde", "Founding Partner"), ("Mads Sørensen", "Partner"), ("Joana Pires", "Associate, Lisbon"),
    ("Lea Kragh", "Associate"), ("Takeshi Ono", "Architect"), ("Eva Gunnarsdóttir", "Architect, Reykjavík"),
]

RECOGNITION = [
    ("2025", "Nordic Architecture Prize — shortlist", "Basalt Archive"),
    ("2024", "Mies van der Rohe Award — nominee", "Timber Pavilion"),
    ("2023", "Wallpaper* Design Awards — Best New Public Building", "Timber Pavilion"),
    ("2022", "FAD Award — Architecture", "House of Clay"),
    ("2021", "Swiss Art Award — Architecture", "Chapel of Still Light"),
]

OFFICES = [
    ("Main studio", "Copenhagen", SITE["address"]),
    ("Satellite office", "Lisbon", ["Rua da Boavista 84", "1200-066 Lisboa", "Portugal"]),
]
