#!/usr/bin/env python3
"""Writes data/seed/seed_documents.json: verified extracts used until the full texts are downloaded.

Each seed document is prepared from a read of the real source on 2026-10-19 (see `url`).  Numbers are copied
from the source tables (tables are generated from data/rules/far_rules.json so the portal's calculator and its
answers can never disagree).  Prose is paraphrased.  When `python -m app.ingest update` downloads the full text of
the same source id, the full text replaces the seed automatically.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
R = json.loads((ROOT / "data/rules/far_rules.json").read_text())
UDA = R["regimes"]["uda2021"]
CMC = R["regimes"]["cmc2008"]
CCC = R["regimes"]["cccdp2019"]
READ_ON = "2026-10-19"
SEEDS = []


def seed(id, title, category, authority, url, pages, gazette_no="", date="", status="reference", notes="", language="en"):
    SEEDS.append({"id": id, "title": title, "category": category, "authority": authority, "gazette_no": gazette_no, "date": date,
                  "language": language, "url": url, "status": status, "read_on": READ_ON,
                  "notes": (notes + " " if notes else "") + f"Verified extract prepared {READ_ON} from the source (not the full text) - run an update to replace it with the full document.",
                  "pages": [{"page": i + 1, "text": t.strip()} for i, t in enumerate(pages)]})


def fmt(v):
    return "Unlimited" if v == "UL" else f"{v:g}"


# ======================================================================= UDA Planning & Development Regulations 2021
seed("uda-pdr-2021-en", "UDA Planning & Development Regulations 2021 (Gazette 2235/54)", "building-regulations", "Urban Development Authority",
     "https://www.uda.gov.lk/attachments/act/2235-54_E.pdf", [
"""Gazette Extraordinary No. 2235/54 of the Democratic Socialist Republic of Sri Lanka, Thursday 8 July 2021 (the Minister's signature is dated 5 July 2021, Colombo).
Title: Urban Development Authority Planning & Development Regulations 2021, made under Section 21 of the Urban Development Authority Law, No. 41 of 1978.
Issuing authority: the Minister of Urban Development and Housing.
Purpose: the regulations replace earlier planning and building gazette notifications dating from 1986 to 2011 and apply to areas the Minister declares to be Urban Development Areas by gazette notice. Regulation 2 lists the notifications that are superseded.""",
"""PART I: Preliminary Planning Clearance (Regulations 1-3). A Preliminary Planning Clearance must be obtained, for example, for subdivisions of 1.0 hectare or more, subdivisions of more than eight lots, and non-residential developments over 400 m2.
PART II: Land Subdivision, Amalgamation and Development (Regulations 4-27), including open space requirements, road widths and turning circles.
PART III: Construction, Alteration and Renovation of Buildings (Regulations 28-44), including building categories, requirements for site, floor, section, elevation and structural drawings, building services and green buildings.
PART IV: Planning, Computation and Designing of Buildings (Regulation 45 onward), covering floor area computation, open spaces and setbacks, internal dimensions, light and ventilation, mechanical ventilation and air conditioning, parking, water supply and wastewater disposal.
Schedule 6 holds the FAR tables (Forms A to E); Schedule 10 holds parking requirements. Reg. 47: permissible floor area is computed excluding the part of the site within street lines. Reg. 66: maximum building height is 3.0 m if the lot is under 150 m2, access is under 3.0 m or frontage is under 6.0 m. Reg. 67 and Schedule 7 set minimum room and ceiling heights (for example residential living rooms: minimum 2.8 m, average 2.4 m).""",
     ], gazette_no="2235/54", date="2021-07-08", status="current",
     notes="UDA's website lists these as the applicable Planning and Development Regulations (the 2020 regulations are on its expired list).")

# ----------------------------------------------------------------------- Kotte MC summary of Schedules (FAR tables etc.)
pages = []
pages.append("""UDA Planning & Development Regulations 2021, Schedule 6 - how the permissible Floor Area Ratio (FAR) is found.
Form A applies in areas whose development plan carries zoning factors: FAR depends on the zone factor (0.50 to 4.00), the land extent and the minimum road width (6 m, 9 m, 12 m or 15 m and above). A 7 m road identified as such in a development plan is treated as a 6 m road.
Form C applies in declared urban areas without zoning-factor plans: FAR depends on the density zone (low, medium or high), the land extent and the road width. The Form C figures for low, medium and high density are identical to the Form A bands for zone factors 0.50-0.74, 0.75-0.99 and 1.00-1.24 respectively.
Conditions and caps: FAR of 10.0 or more is allowed only on roads at least 12 m wide (measured from the road centre). Where no building line exists, the maximum FAR is 9.0. Parking floor area is excluded from FAR. FAR does not apply in zones where the zoning regulations already set a number of floors or a FAR. FAR may be restricted by the development plan according to land slope, and steep land needs clearance from the National Building Research Organisation (slope above 11 degrees - the summary prints this figure ambiguously, so confirm it in the gazette). Permissible floor area is computed excluding the part of the site within street lines (Reg. 47). Forms B and D (roads of 3.0 m and 4.5 m) give floors and plot coverage only, not FAR. UL means unlimited.""")
for band, grid in UDA["form_a"].items():
    bands = UDA["extent_bands"]
    lines = [f"Schedule 6, Form A - permissible FAR, zone factor {band}. Land extent in m2 against minimum road width (6 m / 9 m / 12 m / 15 m and above):"]
    for i, row in enumerate(grid):
        ext = f"{bands[i]:g} to {bands[i + 1]:g}" if i + 1 < len(bands) else f"more than {bands[i]:g}"
        lines.append(f"land extent {ext} m2: 6 m road {fmt(row[0])}; 9 m road {fmt(row[1])}; 12 m road {fmt(row[2])}; 15 m+ road {fmt(row[3])}")
    names = {"0.50-0.74": " (identical to Form C low density)", "0.75-0.99": " (identical to Form C medium density)", "1.00-1.24": " (identical to Form C high density)"}
    lines[0] += names.get(band, "")
    pages.append("\n".join(lines))
pages.append("""Plot coverage (UDA Regulations 2021). Forms B and D (3.0 m and 4.5 m roads): 65% with a minimum site frontage of 6 m. Form E: low rise (up to 7 m high) non-residential 80% (applies only if the whole development is non-residential), residential 65%; 7-15 m 65%; 15-30 m (intermediate rise) 65%; 30-50 m (middle rise) 65%; 50-75 m (high rise) 50%, with 65% allowed only for the podium up to 20% of the tower height or 12 floors, whichever is less; 75 m and above 50%. Plot coverage applies where the zoning regulations do not specify one. Form A and Form C tables cover FAR only.
Building height and floors. Form B (zone-factor areas, roads of 3.0 m and 4.5 m; floors include parking): 3.0 m road - zone factor 0.50-0.74: 1 floor (G); 0.75-1.24: 2 (G+1); 1.25-3.49: 3 (G+2); 3.50-4.00: 3 (G+2). 4.5 m road - 0.50-0.74: 1 (G); 0.75-1.24: 2 (G+1); 1.25-3.49: 3 (G+2); 3.50-4.00: 4 (G+3). Form D (density-based, 3.0 m and 4.5 m roads): low density 1 floor (G); medium density 2 (G+1); high density 3 (G+2). Minimum road width 3.0 m, minimum site frontage 6 m, plot coverage 65%.
Building height is measured from access road level to the roof top, including parking floors. Maximum height is 3.0 m if the lot is under 150 m2, access is under 3.0 m or frontage is under 6.0 m (Reg. 66).""")
pages.append("""Setbacks and open spaces - Form E rear space, side space, frontage and light wells (UDA Planning & Development Regulations 2021, Schedule 6; values as printed in the summary - rear and side space are given without / with natural light and ventilation (NLV)).
Low rise (up to 7 m): minimum frontage 6 m; rear 2.3 m / 2.3 m; side none / 2.3 m; light well width 2.3 m, area 5 m2.
7-15 m: frontage 6 m; rear 3.0 / 3.0 m; side none / 3.0 m; light well 3.0 m, 9 m2.
15-30 m (intermediate rise): frontage 12 m; rear 4.0 / 4.0 m; side 1.0 and 3.0 m / 4.0 m; light well 4.0 m, 16 m2.
30-50 m (middle rise): frontage 20 m; rear 4.0 / 5.0 m; side 3.0 m (both) / 5.0 m; light well 5.0 m, 25 m2.
50-75 m (high rise): frontage 30 m; rear 5.0 / 6.0 m; side 4.0 m (both) / 6.0 m; light well 6.0 m, 36 m2.
75 m and above: rear 5.0 / 6.0 m; side 5.0 m (both) / 6.0 m; light well 6.0 m, area rising by 1 m2 per extra 3 m of height. (Frontage is printed as 'Above 40m' in the summary - unclear.)""")
pages.append("""Setbacks, boundary and open space rules (UDA Planning & Development Regulations 2021, Regulations 55-60, Schedule 9).
Side space from adjoining properties: minimum 1.0 m (Reg. 55). Where a road has no building line or street line: minimum 1.0 m setback from the road edge (Reg. 55). Rear space may change for irregular lots or lots with more than one access road (Reg. 56). Rear space is not required where the rear is a public road or a private right of way at least 6.0 m wide (Reg. 60). Beyond the building line, overhangs may project up to 1.2 m and balconies up to 1.0 m (Reg. 60). A swimming pool may cover up to 50% of the rear space if the rear space exceeds 3.0 m (Reg. 60). Construction on a boundary must be a blind wall, and boundary walls must not exceed 2.0 m (Reg. 57). Basement excavation must stay 1.0 m from the boundary and outside any street line or reservation (Reg. 57). Air wells (Schedule 9): buildings up to 7 m need a minimum clear width of 2.3 m and an area of 5.0 m2 for habitable rooms; utility rooms need 1.0 m width and 1 m2. Front setbacks are governed by the building line or street line (Reg. 58); exact front setback distances are not given in the summary.""")
PK = "UDA Planning & Development Regulations 2021, Schedule 10 - parking requirements"
pages.append(PK + " (depend on usage category, floor area, land extent and road width) - housing and accommodation.\n"
"Single house / bungalow: 1 parking space, plus 1 more where the area exceeds 400 m2. Apartments, 1st category: 1 per unit, +1 where the area exceeds 200 m2, +1 visitor space per 10 units. Apartments, 2nd category: 2 per unit, +1 visitor space per 10 units. Service, studio apartments and quarters: 1 per unit. Hostels ancillary to premises: 1 per 10 rooms; exclusively built hostels: 1 per 5 rooms. Dormitories: 1 per 200 m2. Elders' or children's homes: 1 per 10 rooms (minimum 1). Government resettlement: 15% of total built area excluding service area.")
pages.append(PK + " - retail, shops, restaurants and showrooms.\n"
"Retail shop on a 4.5 m road (25 m2): 1 parking space; on a 6 m road (50 m2): minimum 2. Retail / groceries on a 9 m road: 1 per 50 m2 (excluding service area). Shopping complexes / supermarkets: 1 per 50 m2, bus 1 per 300 m2 (max 2). Vehicle showrooms: 1 per 200 m2, lorry 1 per 200 m2 (max 4). Hardware: 1 per 100 m2, lorry 1 per 500 m2 (max 5). Cinema halls: 1 per 100 m2. Theatres and halls: 1 per 10 seats or 1 per 20 m2, whichever is more. Saloons, beauty parlours, tailors: 4.5 m road up to 15 m2: 1; 6 m up to 30 m2: 2; 9 m above 30 m2: 2 plus 1 per extra 30 m2. Restaurants: 1 per 10 m2 or 1 per 5 seats, whichever is more (9 m road above 50 m2 adds a bus space per 500 m2).")
pages.append(PK + " - offices, hotels and banquet halls.\n"
"Offices / institutions: 1 parking space per 150 m2 where there is no inside customer service; 1 per 500 m2 on 9 m roads. Office complexes above 10,000 m2: 1 per 150 m2, bus 1 per 500 m2, lorry 1. Hotels: city hotel 1 parking space per 10 rooms; motels 1 per room; hotels on a 6 m road with 1-20 rooms 1 per room; hotels on a 9 m road with 1-100 rooms: 1 per room up to 20 rooms, then 1 per 2 rooms from room 21 to 100; hotels above 100 rooms: the same plus 1 per 5 rooms from room 101. Banquet halls: 1 per 5 seats (6 m road up to 100 seats; 9 m road more than 100 seats). Banks and finance institutions are listed with no requirement in the summary.")
pages.append(PK + " - hospitals, health, education.\n"
"Government hospitals: 1 parking space per 10 beds plus 30% of parking allocated for public use. Nursing homes and private hospitals: 1 per 2 beds or 1 per 10 m2, whichever is more. Medical labs / OPD: 1 per 20 m2. Dispensaries on a 6 m road (up to 30 m2): minimum 2. Universities: 1 per permanent academic staff plus what the relevant authority requires. Private higher education: 1 per classroom. Government schools: 1 per 4 classrooms plus 3 drop-off spaces. Private schools: 1 per 2 classrooms plus 1 per 500 m2 of other built-up area plus 3 drop-off spaces. Preschools / day care: 1 per school plus 3 drop-off spaces. Lecture halls (over 100 students): 1 per 100 m2 plus 2 drop-off. Libraries: 6 m road up to 500 m2: 3 spaces; 9 m road over 500 m2: 3 up to 500 m2 plus 1 per 500 m2.")
pages.append(PK + " - industry, stores, recreation, religious and dimensions.\n"
"Medium-scale industry (9 m road, floor up to 1,500 m2): 3 parking spaces up to 250 m2 plus 1 per 250 m2. Large industry (above 1,500 m2): 9 up to 1,500 m2 plus 1 per additional 300 m2. Industrial stores with shops: 1 up to 100 m2 plus 1 per additional 200 m2; without shops: 1 per 500 m2. Godowns: 1 per 500 m2. Parks and theme parks: 1 per 100 m2. Sports complexes / indoor stadiums: 2 per court plus 1 per 10 seats. Commercial pools, gyms and fitness: 1 per 100 m2 plus 1 per 10 seats. Outdoor stadiums: 1 per 100 seats, bus 1 per 1,000 seats (max 10) - the summary also prints 1 per 200 m2 and does not say which applies. Religious places: 1 per 100 m2, bus 1 per 500 m2. Parking dimensions: 90 degree bays need 6.0 m aisles; parallel bays need 3.6 m for one-side parking; a car stall is 2.4 m wide and 4.8 m long for angle parking, 5.5 m long for parallel parking.")
seed("kotte-pnbr-schedules-2021", "Summary of the Schedules of the UDA Planning & Development Regulations 2021 (Kotte MC) - FAR, coverage, setbacks, parking",
     "building-regulations", "Sri Jayawardenepura Kotte Municipal Council", "https://www.kotte.mc.gov.lk/images/pdf/Planning/PnBR_Schedules_2021_Summarized.pdf",
     pages, gazette_no="2235/54", date="2021", status="reference",
     notes="Municipal summary of the gazette schedules; confirm figures against Gazette 2235/54 before submitting plans.")

# ======================================================================= City of Colombo Development Plan 2008
zone_lines = []
for z in CMC["zones"]:
    uses = ", ".join(f"{CMC['uses'][u]}{'' if v['status'] == 'yes' else ' (' + v['note'] + ')'}" for u, v in z.get("uses", {}).items()) or "none listed"
    zone_lines.append(f"{z['name']} (section {z['section']}): {z['far_note']} Permitted uses: {uses}."
                      + (f" Coverage: {z['coverage_note']}." if z.get("coverage_note") else "")
                      + (f" Height: {z['height_note']}." if z.get("height_note") else "")
                      + (f" Minimum plot {z['min_plot_m2']} m2." if z.get("min_plot_m2") else ""))
c1 = ["Form C1 (City of Colombo Development Plan 2008) - maximum permissible FAR by land extent and street width:"]
for i, r in enumerate(CMC["form_c1"], start=1):
    ext = f"{r['min_area']:g} to less than {r['max_area']:g}" if r["max_area"] else f"{r['min_area']:g} and above"
    c1.append(f"row {i}: land extent {ext} m2; public street width between building lines {'-' if r['public_bl_width_m'] is None else format(r['public_bl_width_m'], 'g') + ' m'}; "
              f"private street width {r['private_street_m']:g} m; maximum FAR {'unlimited' if r['far'] is None else '1:' + format(r['far'], 'g')}")
c2 = ["Form C2 (City of Colombo Development Plan 2008) - building categories, floors, plot coverage and open space:"]
for r in CMC["form_c2"]:
    fl = f"{r['floors_min']}" if r["floors_max"] == r["floors_min"] else (f"{r['floors_min']}-{r['floors_max']}" if r["floors_max"] else f"{r['floors_min']} and above")
    c2.append(f"{r['category']}, {fl} floors (including ground): minimum frontage {r['min_frontage_m']:g} m; maximum coverage {r['max_coverage_pct']}%; minimum rear space {r['min_rear_m']:g} m"
              + (f"; one-side space {r['min_one_side_m']:g} m" if r["min_one_side_m"] else "") + (f"; space on each side {r['min_each_side_m']:g} m" if r["min_each_side_m"] else ""))
seed("ccdp-2008-colombo", "City of Colombo Development Plan (Amendment) 2008 - zoning regulations for the Colombo Municipal Council area",
     "building-regulations", "Urban Development Authority / Colombo Municipal Council", "https://www.colombo.mc.gov.lk/downloads/ccdp-2008.pdf", [
"""City of Colombo Development Plan (Amendment) 2008 (Gazette 1535/4; the plan was first gazetted 30 January 1986 as Gazette 386/23 and amended by Gazette 1090/3 of 1999). It covers the Colombo Development Area; the document does not state whether that equals the Colombo Municipal Council boundary. The plan assigns no zone codes, so zones are referred to by section number. The 'Proposed Zoning 2020' map (Map 01) is referenced but not included in the document.
The 2008 amendment sets out seven zones - Concentrated Development Area, Commercial, Mixed Development, Port Related Activity, Primary Residential, Special Mixed Residential and Special Primary Residential - plus a Sea Front zone, Public Open Spaces, and two Development Guide Plan areas. Most zones take their FAR, plot coverage, floors and open spaces from Forms C1 and C2.
Status: the Colombo Commercial City Development Plan 2019 records the City of Colombo Development Plan as in effect for 2008-2025, while UDA's website lists 'City of Colombo Development Plan 1999 and 2008' under 'Expired Regulations'. Confirm with UDA or the CMC which regime governs a given parcel.""",
"\n".join(zone_lines[:5]),
"\n".join(zone_lines[5:]),
"\n".join(c1),
"""Concentrated Development zone, section 4.8(e) - special FAR table. Land extent 1,500 to less than 2,000 m2 with 22 m between building lines: maximum FAR 10.0; with 24 m: FAR 11.0. Land extent 2,000 m2 and above with 24 m: FAR unlimited. All other sites in the zone follow Forms C1 and C2.
The plan does not define Floor Area Ratio and lists no exclusions from floor area. Section 35(1) as substituted states that maximum permissible floor area ratios are given in Form C1. Additional parking floors are allowed irrespective of the Form C1 FAR requirement (section 7.30, new Schedule III item 13) but they still count toward the Form C2 floor limits. Basements must be at least 1.0 m from all lot boundaries (section 35(5) and the amended section 70). The Planning Committee may relax Forms C1 and C2 where 20% or more of a lot falls within a building line (section 9.1(b)(ii)). Zones with street-width rules for schools: minimum street width 12 m (4.5(b), 4.6(b), 4.7(b), 4.8(b)).""",
"\n".join(c2),
     ], gazette_no="1535/4", date="2008", status="verify",
     notes="The extract reproduces Forms C1 and C2 and the zone table as read from the Colombo MC copy.")

seed("gazette-2105-24-en", "Gazette 2105/24 (9 Jan 2019) - Amendment to the City of Colombo Development Plan 1999 and 2008", "building-regulations",
     "Ministry of Megapolis and Western Development", "https://www.documents.gov.lk/view/extra-gazettes/2019/1/2105-24_E.pdf", [
"""Extraordinary Gazette No. 2105/24, Part I, Section (I) (General), Wednesday 9 January 2019 (order approved 2 January 2019). Issuing authority: Ministry of Megapolis and Western Development, signed by Minister Patali Champika Ranawaka. Title: notice of approval of the amendment to the City of Colombo Development Plan 1999 and 2008 (Amendment), made under the Urban Development Authority Law No. 41 of 1978. Area: the City of Colombo; some provisions refer specifically to the Colombo Municipal Council area and to roads maintained by the CMC.
Content: the gazette sets no FAR, plot coverage or height values. Zoning: three areas are rezoned to Mixed Development Zone - from Special Mixed Residential Zone (D.S. Senanayake Junction area) and from Special Primary Residential Zone (two areas near Col. T.G. Jayawardena Mawatha and Union Place). Section 8.1.2 permits residential use except apartment buildings in Zone III (Institutional Zone) of Development Guide Plan Area I.
Building lines: Aloe Avenue - reduced to 12 m, from 15 m. 12th Lane - 5 ft from the road edge, replacing a 12.2 m building line. Roads without street lines and under 9 m wide between Marine Drive and Galle Road (Kollupitiya Junction to Kirulapone Canal) - a 4.5 m acquisition line from the road centre line, to be gifted to the local authority free of charge when development is requested.
Other building-related rules: a 280 m2 threshold for architect-only declarations; inspections every 6 months for intermediate and high-rise buildings and every 3 months for other buildings; a required insurance policy in the owner's name; appeal fees of 25%, 50% and 75% of the development cost for the second, third and fourth appeals.""",
     ], gazette_no="2105/24", date="2019-01-09", status="verify")

seed("gazette-2412-01-en", "Gazette 2412/01 (25 Nov 2024) - Procurement Guidelines 2024: Goods, Works and Non-Consulting Services", "procurement-policy",
     "National Procurement Commission", "https://www.documents.gov.lk/view/extra-gazettes/2024/11/2412-01_E.pdf", [
"""Extraordinary Gazette No. 2412/01, Monday 25 November 2024. Issued by the National Procurement Commission of the Democratic Socialist Republic of Sri Lanka by order of the Commission, signed by its Secretary General. Title: Procurement Guidelines - 2024 on Goods, Works, and Non-Consulting Services. They regulate procurement of goods, works and non-consulting services by Government Institutions.
Replacement of earlier rules: the guidelines replace the 2006 Procurement Guidelines (Goods and Works), related National Procurement Agency manuals and associated circulars. They take effect on 1 January 2025.
Scope: applies to Government Institutions; Provincial Councils may adopt it with adjustments; disposal of inventory and divestiture of public assets are excluded.
Principles: value for money (balancing cost with quality, efficiency, effectiveness and fairness, not just the lowest price); transparency, integrity, fairness, openness, competitiveness and accountability apply throughout the process.""",
"""Ethics: bidders must declare no conflict of interest, a single bid submission and no collusion. Corrupt, fraudulent, collusive, coercive and obstructive practices are prohibited and can lead to sanctions.
Governance: Chief Accounting Officers and Accounting Officers hold overall responsibility. Procurement, bid evaluation and acceptance committees operate at several authority levels, from the High Level Procurement Committee down to regional committees.
Procurement methods: international and national competitive bidding, limited bidding, shopping or quotation requests, direct contracting, force account, emergency procurement, community participation and co-financing. Bidding procedures: single-stage one-envelope, single-stage two-envelope and two-stage procedures, with or without prequalification.
Planning: entities must prepare a three-year master procurement plan, annual proposed and detailed plans, a preparatory plan and a procurement time schedule. Contracts may be sliced or packaged but not to evade authority limits.
Bid requirements: bid security is generally set at 1% to 2% of the estimated value; bid validity must be stated as a calendar date; domestic works contractors need valid CIDA registration; joint ventures and consortia are permitted under defined liability rules.
This extract covers the guideline's opening sections. The gazette is long (about 123,000 characters); the later provisions - evaluation, award, appeals, contract management, sanctions, e-GP, public-private partnerships and sustainable procurement - exist but are not summarised here.""",
     ], gazette_no="2412/01", date="2024-11-25", status="current")

seed("uda-law-consolidated", "Urban Development Authority Law No. 41 of 1978 - structure of the consolidated text", "legislation", "Parliament of Sri Lanka",
     "https://lankalaw.net/wp-content/uploads/2025/03/Urban-Development-Authority-Consolidated-2024.pdf", [
"""The Urban Development Authority Law, No. 41 of 1978, consolidated text (a scanned copy, with some garbled passages). It establishes the UDA to carry out integrated planning and development in areas the Minister declares to be urban development areas. Amendments consolidated: Act No. 70 of 1979, Act No. 4 of 1982, Act No. 44 of 1984, Act No. 49 of 1987, Act No. 41 of 1988 and Act No. 36 of 2007 (consolidated up to 2007).
Part I, Establishment and Constitution (ss. 2-7): the Authority as a body corporate with a Chairman; the Minister may declare development areas; Board of Management; terms, removals, quorum and conflict of interest; committees, seal, advisory committees for each development area.
Part II, Powers and Functions (s. 8): planning, implementing projects, entering contracts, acquiring and disposing of property, housing and slum clearance, infrastructure, land-use policy, regulating other agencies' projects, charging fees, accepting gifts.
Part II A, Planning Procedure (ss. 8A-8L): preparation of development plans, the Planning Committee, draft plans sent to local authorities for comment, approval by the Minister, amendment; s. 8J requires a permit for development activity; certificates of conformity, penalties for unpermitted use, rates remission for qualifying buildings. Section 8D concerns public comment on draft development plans (Act No. 4 of 1982).""",
"""Part III, Finance (ss. 9-12): fund and initial capital, borrowing, debentures, government guarantee. Part IV, Staff (ss. 13-14): Director General and General Manager, officers, secondment. Part V, Acquisition and Disposal of Property (ss. 15-19): vesting of local authority land, compulsory acquisition under the Land Acquisition Act, transfer of state property, sale or lease of land. Part V A, Recovery of Possession (ss. 19A-19I): court procedure for recovering joint-venture buildings. Part VI, General (ss. 20-29 and Schedule): Minister's directions, regulations (s. 21 is the power under which the Planning & Development Regulations are made), entry powers, precedence over other planning enactments, delegation, offences and penalties, enforcement notices, definitions, and a schedule of matters a development plan may cover (land use, building standards, environment, transport, utilities).""",
     ], status="reference")

seed("npa-goods-sbd01-ncb", "Standard Bidding Document NPA/Goods/SBD 01 - National Competitive Bidding (Goods)", "procurement-sbd", "National Procurement Agency",
     "https://www.treasury.gov.lk/api/file/7fae21c1-fb48-45c0-8d2a-265de763bf8a", [
"""Standard Bidding Document for the Procurement of Goods, National Competitive Bidding, coded NPA/Goods/SBD 01, issued by the National Procurement Agency (NPA) of Sri Lanka. No year is stated in the document. It governs procurement of goods and related services, not works or consultancy.
Section I, Instructions to Bidders: eligibility, ethics, bid preparation and submission, evaluation and contract award. Section II, Bidding Data Sheet: purchaser-specific details that supplement and override the general instructions. Section III, Evaluation and Qualification Criteria: the factors used to assess bids and check bidder qualification. Section IV, Bidding Forms: templates for the bid submission, price schedules, bid security, bid-securing declarations and manufacturer authorizations. Section V, Schedule of Requirements: goods and services needed, delivery timelines, technical specifications, drawings, inspection and testing. Section VI, Conditions of Contract: payment, delivery, warranty, liquidated damages, insurance and dispute settlement. Section VII, Contract Data: purchaser-specific details that complement the conditions of contract. Section VIII, Contract Forms: templates for the contract agreement and performance security.
Note: this SBD was issued under the earlier procurement regime; the Procurement Guidelines 2024 (Gazette 2412/01, effective 1 January 2025) replaced the 2006 guidelines and NPA manuals, so check for a revised SBD before use.""",
     ], status="check-current")

seed("npa-goods-sbd01-vol1", "GOSL/NPA/GOODS/SBD 01 - Volume 1 (Instructions to Bidders, Conditions of Contract, Contract Forms)", "procurement-sbd", "National Procurement Agency",
     "https://www.treasury.gov.lk/api/file/86591add-c570-4d37-aaea-ebba8589cc78", [
"""Volume 1 of a standard bidding document issued by the National Procurement Agency of the Government of Sri Lanka, coded GOSL/NPA/GOODS/SBD 01. It is a goods procurement document for National Competitive Bidding (NCB); no year is stated. Volume 1 covers bidder instructions, general contract conditions and contract forms; bid-specific data, evaluation criteria and schedules appear in Volume 2.
Sections in Volume 1: Section I Instructions to Bidders (ITB); Section VI Conditions of Contract (CC); Section VIII Contract Forms, including the Contract Agreement and the Performance Security form.""",
     ], status="check-current")

seed("npa-bidders-guide", "Bidders' Guide to Success in Public Procurement (NPA)", "procurement-policy", "National Procurement Agency",
     "https://www.treasury.gov.lk/api/file/a904e6f9-dff9-4e0b-baed-b8d5e7e35542", [
"""Bidders' Guide to Success in Public Procurement, issued by the National Procurement Agency of Sri Lanka. It helps bidders understand public procurement and avoid errors that lead to bid rejection. It covers goods and works contracts and references ICTAD work registration; it refers to the 2006 Procurement Guidelines and Manual and a 2007 pharmaceuticals guideline. It describes national shopping (quotation), limited bidding, National Competitive Bidding (NCB) and International Competitive Bidding (ICB).
Contents: Preface; 1 How to learn about procurement contracts; 2 Factors to consider before bidding; 3 Purchase of bidding documents; 4 Preparation of bids; 5 Submission of bids; 6 Bid opening; 7 Bid evaluation; 8 Communication of award intention and appeal procedure; 9 Debriefing; 10 Contract formation and signing; 11 Immediate obligations to commence work; 12 During contract execution; Special notes.""",
     ], status="check-current")

seed("npa-procurement-manual-2006", "NPA Procurement Manual 2006 (Goods and Works)", "procurement-policy", "National Procurement Agency",
     "https://www.treasury.gov.lk/api/file/a4b1de27-1848-409b-9551-14df3e441533", [
"""The National Procurement Agency Procurement Manual of the Democratic Socialist Republic of Sri Lanka, issued in 2006 as a companion to the Procurement Guidelines 2006 for Goods and Works. Identified by NPA Circular No. 09 (My No: NPA/CEO/18), dated 1 March 2006. It covers goods and works only; consultant selection is handled separately. It explains International and National Competitive Bidding, Limited Bidding, Shopping, Direct Contracting and emergency procedures.
Chapters: 1 General (objectives and scope); 2 Institutions, procurement committees and their functions; 3 Procurement methods; 4 Procurement preparedness and planning; 5 Bidding documents; 6 Invitation to bid and closing/opening of bids; 7 Bid evaluation; 8 Award of contract; acronyms and appended forms, formats and circulars.
Status: superseded - Gazette 2412/01 (Procurement Guidelines 2024, effective 1 January 2025) replaces the 2006 guidelines, related NPA manuals and associated circulars.""",
     ], date="2006-03-01", status="superseded")

seed("dpf-supplement-37", "Supplement 37 to the Procurement Manual - Contents of the Bidding Document (Guideline 5.2.1)", "procurement-sbd", "Department of Public Finance",
     "https://www.treasury.gov.lk/api/file/4cacc73f-e8b0-4af6-b604-2def9c51ff14", [
"""Supplement 37 to the Procurement Manual, issued by the Department of Public Finance, Democratic Socialist Republic of Sri Lanka, issue and effective date 09.04.2021. It supplements the Government Procurement Guidelines 2006 (Goods and Works) and is identified by Guideline Reference 5.2.1. Subject: contents of the bidding document for procurement of works, goods and services other than consultancy services.
Contents of a bidding document under Guideline 5.2.1: Invitation to Bid; Instructions to Bidders; Bidding Data; Conditions of Contract; Contract Data / Special Conditions; Specifications and Employer's Requirements; Drawings / Sketches; Bills of Quantities and Activity Schedule; Schedule of Requirements; Form of Contract; Price Schedules; Form of Bid; sample security forms and advance payment guarantee forms. Note 1 concerns pre-data for granite-bearing lands in the Contract Data / Special Conditions.""",
     ], date="2021-04-09", status="check-current")

seed("cccdp-2019-v1", "Colombo Commercial City Development Plan 2019-2030 - Volume I (situational analysis)", "development-plans", "Urban Development Authority",
     "https://www.uda.gov.lk/attachments/devplan_detailed/Development%20Plans%202019-2030/commercial%20city/CommercialCity-eng-v1.pdf", [
"""The Colombo Commercial City Development Plan (CCCDP) 2019-2030, prepared by the UDA under the Urban Development Authority Law No. 41 of 1978 and published in July 2019. The planning area covers eight local authority areas - the Colombo Municipal Council (CMC), Dehiwala-Mount Lavinia Municipal Council, Boralesgamuwa, Kolonnawa, Peliyagoda and Wattala-Mabola Urban Councils, and parts of Wattala and Kelaniya Pradeshiya Sabhas - totalling 103.71 km2 with 149 Grama Niladhari Divisions. No gazette number or approval date for the final CCCDP appeared in the volume read.
Gazette references for earlier plans: CMC - the City of Colombo Development Plan was gazetted on 30 Jan 1986 (Gazette No. 386/23), amended by No. 1090/3 (1999) and No. 1535/4 (2008), in effect for 2008-2025. Dehiwala-Mount Lavinia MC - gazetted 27 Mar 2009 (Gazette No. 1594/32), in effect 2008-2020. Kolonnawa and Boralesgamuwa UCs - only draft plans. Core Area of the Metro Colombo Development Region - Extraordinary Gazette No. 2049/11 (11 Dec 2017), a separate designation from the CCCDP.
History of zoning: the 1999 plan introduced land use zoning, building regulations, building density regulations and Development Guide Plans; the 2008 amendment set seven zones (Concentrated Development Area, Commercial, Mixed Development, Port Related Activity, Primary Residential, Special Mixed Residential, Special Primary Residential) and two Development Guide Plan areas. Volume I covers the situational analysis; Volume II the vision, strategies and implementation; Volume III the special and general Planning & Building Regulations for 2019-2030 (not yet ingested).""",
     ], date="2019-07", status="verify")

seed("cccdp-2019-v2", "Colombo Commercial City Development Plan 2019-2030 - Volume II (strategies and zones)", "development-plans", "Urban Development Authority",
     "https://www.uda.gov.lk/attachments/devplan_detailed/Development%20Plans%202019-2030/commercial%20city/CommercialCity-eng-v2.pdf", [
"""Volume II of the Colombo Commercial City Development Plan 2019-2030 states that the Planning & Building Regulations are in a separate document, Volume III, so no FAR, coverage or setback values for CCCDP zones appear in Volume II.
Spatial structure (chapter 5, Spatial Development Strategy): three broader density zones (high, moderate, low); 13 character zones; 51 sub-density zones; settlement promotion areas (1 high-density, 3 moderate-density, 2 low-density); and Special Height Control Zones related to the airport and the Kolonnawa Oil Refinery. Aqua Region 06 'The Garden' (about 740 ha) is relatively low density; Aqua Region 07, the Bolgoda River Based Development Area (about 1,540 ha), is low-density residential and recreational with restricted heights because of aviation limits from Ratmalana airport.
Reservations (section 4.2.2, Table 4.4): canal reservations of 1.0-6.5 m from the bank edge depending on canal width (open canals); Kelani River 18 m; Beira Lake 6.5 m. Coastal zone: developments need Coast Conservation Department clearance and the coastal zone extends 300 m landward of the mean high-water level.""",
     ], date="2019-07", status="verify")

seed("cccdp-2019-common-regs", "Colombo Commercial City Development Plan - common regulations (plan website summary)", "development-plans", "Urban Development Authority",
     "https://citydpuda2030.wixsite.com/developmentplans/common-regulation", [
"""Common regulations listed on the Colombo Commercial City Development Plan website (an informational site, not a gazette; the page gives no area, legal status or gazette details).
FAR bonuses: a developer adjoining a waterfront who provides public access gets an additional 10% of the relevant FAR. A building using solar power gets an additional 5% of either the relevant FAR or plot coverage, as the Authority decides.
Other values: 50% of each lot's open space should have natural shade (trees) and 5% should be permeable earth. Boundary walls above 3 feet are not allowed in these areas. A 'Proposed Road' must have a minimum physical width of 7 m. One-quarter of the land width should be arranged so the waterfront can be seen from the access road. Buildings on a commercial street are capped at four storeys, subject to the Authority's approval. Lots on the boundary between two zones may use either adjoining zone's permitted uses (the first lot or the area within a 100 m buffer; not the Garden Zone). Heights are controlled in the Lotus Tower visual corridors with maximums measured from mean sea level. A Zoning Factor may be used by an applicant for lots on a zone boundary. All planning zones remain subject to Acts, Gazette Notifications and Circulars of other state agencies. Waterfront developments need a wastewater management plan that complies with Central Environmental Authority rules, and landscape plans must accompany building plans.""",
     ], status="unverified")

seed("uda-regulation-status", "Status of UDA regulations and Colombo development plans (from the UDA website, 19 Oct 2026)", "building-regulations", "Urban Development Authority",
     "https://www.uda.gov.lk/expired_regulations.html", [
"""What the UDA website shows (read 19 October 2026).
Applicable Regulations page: lists the Urban Development Authority Planning and Development Regulation 2021, identifier 2235/54, in Sinhala and English (https://www.uda.gov.lk/attachments/act/2235-54_S.pdf and 2235-54_E.pdf). The regulations tree page names the Planning and Development Regulations, Gazette No. 2235/54, established 8 July 2021, and links to pages for applicable regulations, expired regulations and the review and revision of the Planning and Development Regulations. It does not list amendments to the 2021 regulations.
Expired Regulations page (items listed): Planning & Development Regulations 1986 (Sinhala, Tamil, English); a 2019 development plan cancellation gazette notice; Planning & Development Regulations 2020 (Sinhala, English); UDA Declared Area maps (November 2019 and September 2020); City of Colombo Development Plan 1999 and 2008 (English, Sinhala, Tamil); amendment of Planning & Building Regulations 2008-2020 for Sri Jayawardenepura Kotte MC; City of Colombo Development Plan (Amendment) No. 2105/23 - 2019 and No. 2105/22 - 2019; City of Colombo Development Plan (Compiled Edition); Bolgoda Special Regulations; Benthara River Development Regulations; guidelines for Western Province wetlands zoning; Special Regulations; Concentrated Development Zone; and others. The page gives no gazette numbers and does not mark individual items. The Colombo Commercial City Development Plan does not appear on that page.
Other UDA pages: the 'Applicable development plans' page links the Colombo Development Plan 2021-2030 (English PDF https://www.uda.gov.lk/attachments/dev-plans-2021-2030/colombo_eng.pdf) but does not state its legal status or gazette number. Items published 6 November 2025: the Strategic Tourism Zone, Eastern Province, Stage 4 Detailed Masterplan Report (March 2025), and the Preparation of a Review Plan of the Master Plan for the Development of the Western Province and Colombo City - the only Colombo-related entry on the regulations tree page, and a review plan rather than a named Colombo Commercial City development plan.
Because the City of Colombo Development Plan (2008, as amended in 2019) is listed as expired while the Colombo Commercial City Development Plan 2019-2030 has its regulations in a Volume III that was not ingested, confirm with UDA which regulations currently apply to a Colombo parcel before relying on a FAR figure.""",
     ], status="reference")

# ======================================================================= guide to the calculator (generated from the rules)
guide = ["""How the portal's FAR calculator works. Permissible floor area = permissible FAR x net site area (the land extent minus any part within street lines or building-line reservations). The calculator never invents a number: every FAR comes from a printed table row, which it reports, together with the regime, the citation and any warnings.
Regimes: (1) City of Colombo Development Plan (Amendment) 2008 for the Colombo Municipal Council area - choose the zone; FAR comes from Form C1 (or the Concentrated Development table), coverage and spaces from Form C2 and the zone rules. (2) UDA Planning & Development Regulations 2021 (Gazette 2235/54) - FAR comes from Form A (zone factor) or Form C (density); narrow roads of 3.0-6.0 m use Form B / Form D floors instead of FAR; coverage and spaces come from Form E by height.
Units: 1 perch = 25.29 m2; 1 acre = 160 perches = 4,046.9 m2; 1 hectare = 10,000 m2; 1 sq ft = 0.0929 m2; 1 ft = 0.3048 m. The plan's 12.2 m street width is 40 ft; a 40 ft road is treated as meeting it.
Land-extent bands are printed as ranges; a value exactly on a boundary is placed in the lower band (the conservative reading) and the calculator warns about it. The band is chosen on the net area; if the gross area would select a different band the calculator warns.
Parking floor area is excluded from FAR in the UDA 2021 regulations; in the Colombo plan only additional parking floors beyond the regulatory requirement are exempt (section 7.30)."""]
for n in UDA["notes"]:
    guide.append("UDA 2021 note: " + n)
for n in CMC["notes"]:
    guide.append("Colombo plan note: " + n)
guide.append(CCC["status_note"])
seed("portal-far-guide", "Guide to the FAR calculator - rules, units and assumptions", "building-regulations", "Ceylon Buildex", "", ["\n".join(guide)], status="reference",
     notes="Generated from data/rules/far_rules.json.")

out = ROOT / "data/seed/seed_documents.json"
out.write_text(json.dumps(SEEDS, indent=1, ensure_ascii=False))
print("wrote", out, len(SEEDS), "seed documents,", sum(len(s["pages"]) for s in SEEDS), "pages")
