import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getNextProject, getProject, projects } from "@/lib/projects";
import ParallaxFigure from "@/components/ParallaxFigure";
import Reveal from "@/components/Reveal";
import BookSpread from "@/components/BookSpread";

type Props = { params: { slug: string } };

export function generateStaticParams() {
  return projects.map((p) => ({ slug: p.slug }));
}

export function generateMetadata({ params }: Props): Metadata {
  const p = getProject(params.slug);
  return p ? { title: p.title, description: p.lead } : {};
}

export default function ProjectPage({ params }: Props) {
  const p = getProject(params.slug);
  if (!p) notFound();
  const next = getNextProject(p.slug);

  const specs: [string, string][] = [
    ["Year", String(p.year)],
    ["Location", `${p.city}, ${p.country}`],
    ["Typology", p.typology],
    ["Status", p.status],
    ["Area", p.area],
    ["Client", p.client],
  ];

  return (
    <article>
      {/* ——— The monograph: fixed narrative page + scrolling plates ——— */}
      <div className="lg:grid lg:grid-cols-12">
        <header className="no-scrollbar flex flex-col justify-between gap-12 border-b px-4 pb-12 pt-10 sm:px-6 lg:sticky lg:top-0 lg:col-span-5 lg:h-[100svh] lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-14 lg:py-14">
          <div className="flex items-center justify-between">
            <Link href="/archive" className="label hairline-link hover:text-charcoal">
              ← Index
            </Link>
            <span className="label tabular-nums">
              {p.index} / {String(projects.length).padStart(2, "0")}
            </span>
          </div>

          <div>
            <p className="label mb-6 tracking-[0.3em]">[ {p.title} ]</p>
            <h1 className="font-serif text-[clamp(52px,5.6vw,96px)] leading-[0.92] tracking-[-0.02em]">
              <Reveal lines={p.title.split(" ").reduce<string[]>((acc, w, i, a) => (i % 2 ? acc : [...acc, a.slice(i, i + 2).join(" ")]), [])} delay={0.45} />
            </h1>
            <p className="mt-8 max-w-[440px] font-serif text-[22px] italic leading-snug text-charcoal/80">{p.lead}</p>
          </div>

          <div className="space-y-8">
            <dl className="grid grid-cols-2 gap-x-8 border-t">
              {specs.map(([k, v]) => (
                <div key={k} className="border-b py-3">
                  <dt className="label">{k}</dt>
                  <dd className="mt-1 text-[13px]">{v}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="label mb-3">Materials</p>
              <ul className="space-y-2.5">
                {p.materials.map((m) => (
                  <li key={m.name} className="flex items-center gap-3 text-[13px]">
                    <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: m.swatch }} />
                    <span>{m.name}</span>
                    <span className="ml-auto text-right text-[11px] text-mutedText">{m.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </header>

        <div className="space-y-20 px-4 py-12 sm:px-6 lg:col-span-7 lg:space-y-32 lg:px-14 lg:py-14">
          {p.figures.map((f, i) => (
            <div key={i} className={i === 1 ? "lg:ml-[18%]" : i === 2 ? "lg:mr-[10%]" : ""}>
              <ParallaxFigure
                src={f.src}
                alt={`${p.title}: ${f.caption}`}
                caption={f.caption}
                number={String(i + 1).padStart(2, "0")}
                priority={i === 0}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ——— Printed spread ——— */}
      <BookSpread project={p} />

      {/* ——— Next ——— */}
      <Link
        href={`/projects/${next.slug}`}
        data-cursor="Next project"
        className="group grid border-t lg:grid-cols-12"
      >
        <div className="flex flex-col justify-between gap-16 px-4 py-14 sm:px-6 lg:col-span-7 lg:px-14 lg:py-20">
          <span className="label">Next project — {next.index}</span>
          <span className="font-serif text-[clamp(48px,6.4vw,112px)] leading-[0.92] tracking-[-0.02em] transition-transform duration-700 ease-editorial group-hover:translate-x-4">
            {next.title} <span className="inline-block">→</span>
          </span>
          <span className="label">
            {next.city}, {next.country} — {next.year}
          </span>
        </div>
        <div className="relative hidden overflow-hidden lg:col-span-5 lg:block">
          <Image
            src={next.cover}
            alt=""
            fill
            sizes="35vw"
            placeholder="blur"
            className="object-cover grayscale transition-all duration-[1200ms] ease-editorial group-hover:scale-[1.03] group-hover:grayscale-0"
          />
        </div>
      </Link>
    </article>
  );
}
