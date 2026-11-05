import type { StaticImageData } from "next/image";

import monolith1 from "@/public/images/monolith-1.jpg";
import monolith2 from "@/public/images/monolith-2.jpg";
import monolith3 from "@/public/images/monolith-3.jpg";
import timber1 from "@/public/images/timber-1.jpg";
import timber2 from "@/public/images/timber-2.jpg";
import timber3 from "@/public/images/timber-3.jpg";
import clay1 from "@/public/images/clay-1.jpg";
import clay2 from "@/public/images/clay-2.jpg";
import clay3 from "@/public/images/clay-3.jpg";
import basalt1 from "@/public/images/basalt-1.jpg";
import basalt2 from "@/public/images/basalt-2.jpg";
import basalt3 from "@/public/images/basalt-3.jpg";
import chapel1 from "@/public/images/chapel-1.jpg";
import chapel2 from "@/public/images/chapel-2.jpg";
import chapel3 from "@/public/images/chapel-3.jpg";
import courtyard1 from "@/public/images/courtyard-1.jpg";
import courtyard2 from "@/public/images/courtyard-2.jpg";
import courtyard3 from "@/public/images/courtyard-3.jpg";

export type Material = { name: string; note: string; swatch: string };

export type Figure = { src: StaticImageData; caption: string };

export type Project = {
  slug: string;
  index: string;
  title: string;
  typology: string;
  city: string;
  country: string;
  year: number;
  status: "Completed" | "In progress" | "Competition";
  area: string;
  client: string;
  team: string;
  lead: string;
  narrative: string[];
  materials: Material[];
  cover: StaticImageData;
  figures: Figure[];
};

export const projects: Project[] = [
  {
    slug: "the-monolithic-void",
    index: "01",
    title: "The Monolithic Void",
    typology: "Private Residence",
    city: "Sintra",
    country: "Portugal",
    year: 2024,
    status: "Completed",
    area: "412 m²",
    client: "Private",
    team: "A. Halde, M. Sørensen, J. Pires",
    lead: "A single mass of board-formed concrete, carved open by one vertical cut of light.",
    narrative: [
      "Set into a granite slope above the Atlantic fog line, the house is conceived as one continuous casting. Its rooms are not built so much as subtracted, a sequence of hollows pressed into the hill.",
      "A single slot, nine metres tall and forty centimetres wide, is the only opening on the entrance façade. Over the course of a day its blade of light travels across the hall, the stair and the dining table, a slow sundial for the household.",
      "Every surface carries the grain of the pine boards it was cast against. Nothing is cladded, nothing is painted; the structure is the finish.",
    ],
    materials: [
      { name: "Board-formed concrete", note: "Pine shuttering, 120 mm boards", swatch: "#9a958d" },
      { name: "Honed basalt", note: "Floors and thresholds", swatch: "#2f2d2b" },
      { name: "Oiled oak", note: "Joinery and window frames", swatch: "#a88763" },
    ],
    cover: monolith1,
    figures: [
      { src: monolith1, caption: "Entrance hall, the nine-metre light slot" },
      { src: monolith2, caption: "Stair void, late afternoon" },
      { src: monolith3, caption: "The house seen from the lower terrace" },
    ],
  },
  {
    slug: "timber-pavilion",
    index: "02",
    title: "Timber Pavilion",
    typology: "Cultural Pavilion",
    city: "Vejle",
    country: "Denmark",
    year: 2023,
    status: "Completed",
    area: "260 m²",
    client: "Vejle Fjord Foundation",
    team: "A. Halde, L. Kragh, T. Ono",
    lead: "Two hundred and forty spruce fins, tuned to the angle of the northern sun.",
    narrative: [
      "The pavilion is a single gallery, sixty metres long, that runs along the fjord's edge. Its walls are a rhythm of vertical fins in cross-laminated spruce, spaced so that walking its length reads like turning the pages of a book.",
      "On the south the fins close into a solid wall; on the north they open toward the water, admitting only reflected light. Exhibitions are lit by the fjord itself.",
      "The building was prefabricated in eleven sections and assembled on site in nine days, sitting lightly on screw piles that leave the shoreline untouched.",
    ],
    materials: [
      { name: "Cross-laminated spruce", note: "Primary structure and fins", swatch: "#cfae86" },
      { name: "Douglas fir", note: "Floor boards, 220 mm widths", swatch: "#b0855c" },
      { name: "Lime plaster", note: "End walls, hand-trowelled", swatch: "#ece6db" },
    ],
    cover: timber1,
    figures: [
      { src: timber1, caption: "The gallery, looking east" },
      { src: timber2, caption: "Reading room toward the fjord" },
      { src: timber3, caption: "North elevation, fin rhythm" },
    ],
  },
  {
    slug: "house-of-clay",
    index: "03",
    title: "House of Clay",
    typology: "Rural Retreat",
    city: "Évora",
    country: "Portugal",
    year: 2022,
    status: "Completed",
    area: "188 m²",
    client: "Private",
    team: "A. Halde, J. Pires",
    lead: "Walls of rammed earth dug from the site itself, half a metre thick and cool at noon.",
    narrative: [
      "In the Alentejo plain, summer heat is the defining condition. The house answers with mass: rammed-earth walls fifty centimetres thick, compacted in layers from soil excavated for the foundations.",
      "Openings are few and deep. Each frames a single element of the landscape: a cork oak, a well, the horizon line.",
      "Inside, natural clay plaster regulates humidity, and the floors are laid in handmade terracotta fired twenty kilometres away.",
    ],
    materials: [
      { name: "Rammed earth", note: "Site-excavated soil, 500 mm", swatch: "#b98d72" },
      { name: "Natural clay plaster", note: "Interior walls, unsealed", swatch: "#dcc2b0" },
      { name: "Terracotta", note: "Handmade floor tiles", swatch: "#9d5f45" },
    ],
    cover: clay1,
    figures: [
      { src: clay1, caption: "Living room, morning light on clay" },
      { src: clay2, caption: "Approach across the plain" },
      { src: clay3, caption: "Courtyard passage" },
    ],
  },
  {
    slug: "basalt-archive",
    index: "04",
    title: "Basalt Archive",
    typology: "Library & Archive",
    city: "Reykjavík",
    country: "Iceland",
    year: 2025,
    status: "In progress",
    area: "3,400 m²",
    client: "City of Reykjavík",
    team: "A. Halde, M. Sørensen, E. Gunnarsdóttir",
    lead: "A municipal archive wrapped in a deep screen of cast basalt fins.",
    narrative: [
      "The archive holds four centuries of civic records in a climate-stable core, surrounded by a public reading hall that rings the building at street level.",
      "The façade is a screen of cast basalt fins whose depth varies with orientation, deepest to the south and west, so that the reading hall is evenly lit through every season, including the low winter sun.",
      "Construction began in 2025; the building opens in the spring of 2027.",
    ],
    materials: [
      { name: "Cast basalt", note: "Façade fins, recycled aggregate", swatch: "#4c5253" },
      { name: "Polished concrete", note: "Reading hall floor", swatch: "#a5a9a8" },
      { name: "Birch plywood", note: "Shelving and carrels", swatch: "#d9c9a8" },
    ],
    cover: basalt1,
    figures: [
      { src: basalt1, caption: "West façade, basalt screen" },
      { src: basalt2, caption: "Stack corridor" },
      { src: basalt3, caption: "Site study, Faxaflói bay" },
    ],
  },
  {
    slug: "chapel-of-still-light",
    index: "05",
    title: "Chapel of Still Light",
    typology: "Sacred Space",
    city: "Ticino",
    country: "Switzerland",
    year: 2021,
    status: "Completed",
    area: "96 m²",
    client: "Parish of Valle Maggia",
    team: "A. Halde, R. Bianchi",
    lead: "A room for forty people, lit only from above.",
    narrative: [
      "A small chapel on a valley floor, replacing a nineteenth-century oratory lost to a flood. The brief asked only for a room for forty people and a bell.",
      "The walls are local gneiss, laid dry by two masons over one summer. The roof is a single concrete plate held clear of the walls by a band of glass, so that light falls down the stone surfaces rather than into the room.",
    ],
    materials: [
      { name: "Maggia gneiss", note: "Dry-laid walls", swatch: "#b0aa9f" },
      { name: "White concrete", note: "Roof plate", swatch: "#e2dfd8" },
      { name: "Chestnut", note: "Benches and door", swatch: "#6f4e35" },
    ],
    cover: chapel1,
    figures: [
      { src: chapel1, caption: "Light falling along the north wall" },
      { src: chapel2, caption: "The perimeter glass band" },
      { src: chapel3, caption: "Nave at dusk" },
    ],
  },
  {
    slug: "courtyard-houses",
    index: "06",
    title: "Courtyard Houses",
    typology: "Housing",
    city: "Palma",
    country: "Spain",
    year: 2020,
    status: "Completed",
    area: "2,150 m²",
    client: "IBAVI Housing Institute",
    team: "A. Halde, L. Kragh, C. Ferrer",
    lead: "Eighteen social homes, each organised around its own walled garden.",
    narrative: [
      "Eighteen affordable homes arranged as a low carpet of walled courtyards, a contemporary reading of the Mallorcan patio.",
      "Each house turns inward to a private garden planted with a single tree, and outward to a shared lane shaded by pergolas. Walls are built in marès sandstone quarried on the island.",
    ],
    materials: [
      { name: "Marès sandstone", note: "Load-bearing walls", swatch: "#d8cdb8" },
      { name: "Lime render", note: "Courtyard faces", swatch: "#efebe3" },
      { name: "Pine pergolas", note: "Shared lanes", swatch: "#b8946b" },
    ],
    cover: courtyard1,
    figures: [
      { src: courtyard1, caption: "A private courtyard" },
      { src: courtyard2, caption: "Lane elevation" },
      { src: courtyard3, caption: "Covered passage between houses" },
    ],
  },
];

export const getProject = (slug: string) => projects.find((p) => p.slug === slug);

export const getNextProject = (slug: string) => {
  const i = projects.findIndex((p) => p.slug === slug);
  return projects[(i + 1) % projects.length];
};

export const typologies = Array.from(new Set(projects.map((p) => p.typology)));
