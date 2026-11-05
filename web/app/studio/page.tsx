import type { Metadata } from "next";

import studio1 from "@/public/images/studio-1.jpg";
import studio2 from "@/public/images/studio-2.jpg";
import { site } from "@/lib/site";
import Reveal from "@/components/Reveal";
import ParallaxFigure from "@/components/ParallaxFigure";

export const metadata: Metadata = { title: "Studio" };

const principles = [
  ["Subtract before adding", "We begin by asking what a building can do without. Most of our best rooms are made by removing."],
  ["Let structure finish", "Where the structure can be the surface, we let it. Fewer layers age more honestly."],
  ["Draw with light", "Every plan is also a drawing of the sun's path. Openings are placed for an hour, not an elevation."],
  ["Build near", "Materials are sourced as close to site as practical: earth from the excavation, stone from the valley."],
];

const people = [
  ["Astrid Halde", "Founding Partner"],
  ["Mads Sørensen", "Partner"],
  ["Joana Pires", "Associate, Lisbon"],
  ["Lea Kragh", "Associate"],
  ["Takeshi Ono", "Architect"],
  ["Eva Gunnarsdóttir", "Architect, Reykjavík"],
];

const recognition = [
  ["2025", "Nordic Architecture Prize — shortlist", "Basalt Archive"],
  ["2024", "Mies van der Rohe Award — nominee", "Timber Pavilion"],
  ["2023", "Wallpaper* Design Awards — Best New Public Building", "Timber Pavilion"],
  ["2022", "FAD Award — Architecture", "House of Clay"],
  ["2021", "Swiss Art Award — Architecture", "Chapel of Still Light"],
];

export default function StudioPage() {
  return (
    <div className="px-4 pb-28 pt-12 sm:px-6 lg:px-14 lg:pt-16">
      <header className="grid gap-12 border-b pb-16 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <p className="label mb-6">[ The studio ]</p>
          <h1 className="font-serif text-[clamp(44px,5.8vw,96px)] leading-[0.98] tracking-[-0.02em]">
            <Reveal
              delay={0.4}
              lines={[
                "A small office for",
                <>
                  buildings that <em className="italic">take</em>
                </>,
                "their time.",
              ]}
            />
          </h1>
        </div>
        <div className="flex flex-col justify-end gap-4 text-[13px] leading-relaxed text-charcoal/75 lg:col-span-4">
          <p>
            Halde was founded in {site.city} in {site.founded} by Astrid Halde. We are fourteen people working between
            Copenhagen and Lisbon, on a deliberately small number of projects at a time.
          </p>
          <p>
            Our work spans private houses, cultural and sacred buildings, and public housing. The scale changes;
            the questions stay the same: mass, light, and how a room will feel in forty years.
          </p>
        </div>
      </header>

      <section className="grid gap-16 py-20 lg:grid-cols-12 lg:py-28">
        <div className="lg:col-span-5">
          <ParallaxFigure src={studio1} alt="The studio on Strandgade" caption="The studio, Strandgade 27B" number="01" sizes="(min-width:1024px) 35vw, 100vw" />
        </div>
        <div className="lg:col-span-6 lg:col-start-7">
          <p className="label mb-8">Principles</p>
          <ol className="border-t">
            {principles.map(([title, body], i) => (
              <li key={title} className="grid grid-cols-12 gap-4 border-b py-7">
                <span className="label col-span-2 tabular-nums text-charcoal">0{i + 1}</span>
                <div className="col-span-10">
                  <h2 className="font-serif text-3xl leading-tight">{title}</h2>
                  <p className="mt-2 max-w-[460px] text-[13px] leading-relaxed text-mutedText">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="grid gap-16 border-t py-20 lg:grid-cols-12 lg:py-28">
        <div className="lg:col-span-5">
          <p className="label mb-8">People</p>
          <ul className="border-t">
            {people.map(([name, role]) => (
              <li key={name} className="flex items-baseline justify-between border-b py-4">
                <span className="font-serif text-2xl">{name}</span>
                <span className="label">{role}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:col-span-6 lg:col-start-7">
          <p className="label mb-8">Recognition</p>
          <ul className="border-t">
            {recognition.map(([year, award, project]) => (
              <li key={award} className="grid grid-cols-12 gap-4 border-b py-4 text-[13px]">
                <span className="col-span-2 tabular-nums">{year}</span>
                <span className="col-span-7">{award}</span>
                <span className="col-span-3 text-right text-mutedText">{project}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <ParallaxFigure src={studio2} alt="Model workshop" caption="Model workshop, winter" number="02" sizes="(min-width:1024px) 80vw, 100vw" strength={6} />
    </div>
  );
}
