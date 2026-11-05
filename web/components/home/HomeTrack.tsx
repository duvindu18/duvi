"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, useScroll, useTransform, type MotionValue } from "framer-motion";

import { projects, type Project } from "@/lib/projects";
import { site } from "@/lib/site";
import { useSplash } from "@/lib/splash-store";
import { EASE_CURTAIN, EASE_EDITORIAL } from "@/lib/motion";
import { useInertiaScroll } from "./useInertiaScroll";
import Reveal from "../Reveal";

export default function HomeTrack() {
  const ready = useSplash((s) => s.done);
  const { ref, next, prev } = useInertiaScroll<HTMLDivElement>();
  const { scrollXProgress } = useScroll({ container: ref });
  const [active, setActive] = useState(0);

  return (
    <section className="relative flex flex-col lg:h-[100svh]" aria-label="Selected works">
      <div
        ref={ref}
        className="no-scrollbar relative flex flex-1 flex-col lg:flex-row lg:overflow-x-auto lg:overflow-y-hidden"
      >
        <IntroPanel ready={ready} />
        <MosaicPanel progress={scrollXProgress} ready={ready} />
        <ChapterPanel />

        {/* Desktop: editorial strip of numbered project panels */}
        <div className="hidden lg:flex">
          {projects.map((p, i) => (
            <ProjectPanel key={p.slug} project={p} active={active === i} onActivate={() => setActive(i)} />
          ))}
        </div>

        {/* Mobile / tablet: stacked cards */}
        <div className="grid gap-x-4 gap-y-12 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:hidden">
          {projects.map((p) => (
            <MobileCard key={p.slug} project={p} />
          ))}
        </div>

        <EndPanel />
      </div>

      {/* Track footer: index, progress hairline, prev / next */}
      <div className="hidden h-16 shrink-0 items-center gap-8 border-t px-8 lg:flex">
        <span className="label w-40">Scroll or use ← →</span>
        <div className="relative h-px flex-1 bg-hairline">
          <motion.div className="absolute inset-y-0 left-0 w-full origin-left bg-charcoal" style={{ scaleX: scrollXProgress }} />
        </div>
        <div className="flex gap-2">
          <RoundButton label="Previous" onClick={prev}>←</RoundButton>
          <RoundButton label="Next" onClick={next}>→</RoundButton>
        </div>
      </div>
    </section>
  );
}

function RoundButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-full border border-black/10 text-[13px] transition-all duration-500 ease-editorial hover:border-charcoal hover:bg-charcoal hover:text-canvas"
    >
      {children}
    </button>
  );
}

/* ——— 1. Intro ————————————————————————————————————————————————— */

function IntroPanel({ ready }: { ready: boolean }) {
  return (
    <div
      data-snap
      className="flex shrink-0 flex-col justify-between px-4 pb-14 pt-10 sm:px-6 lg:w-[min(46vw,720px)] lg:px-14 lg:py-14"
    >
      <motion.p
        className="label"
        initial={{ opacity: 0 }}
        animate={ready ? { opacity: 1 } : {}}
        transition={{ duration: 1, delay: 0.6 }}
      >
        [ Selected works 2020 — 2026 ]
      </motion.p>

      <h1 className="my-16 font-serif text-[clamp(48px,6.2vw,104px)] leading-[0.95] tracking-[-0.02em] lg:my-0">
        <Reveal
          play={ready}
          delay={0.15}
          lines={[
            "Rooms shaped",
            <>
              by <em className="italic">mass,</em> light
            </>,
            "& slow time.",
          ]}
        />
      </h1>

      <motion.div
        className="grid max-w-[520px] grid-cols-2 gap-8 border-t pt-6"
        initial={{ opacity: 0, y: 12 }}
        animate={ready ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 1.1, delay: 0.7, ease: EASE_EDITORIAL }}
      >
        <p className="text-[13px] leading-relaxed text-charcoal/80">{site.description}</p>
        <dl className="space-y-3 text-[12px]">
          <div>
            <dt className="label">Founded</dt>
            <dd>{site.founded}, {site.city}</dd>
          </div>
          <div>
            <dt className="label">Practice</dt>
            <dd>Houses, culture, public space</dd>
          </div>
        </dl>
      </motion.div>
    </div>
  );
}

/* ——— 2. Mosaic ———————————————————————————————————————————————— */

function MosaicPanel({ progress, ready }: { progress: MotionValue<number>; ready: boolean }) {
  const col = (dir: number) => (dir > 0 ? ["-6%", "4%"] : ["4%", "-10%"]);
  const y0 = useTransform(progress, [0, 0.5], col(1));
  const y1 = useTransform(progress, [0, 0.5], col(-1));
  const y2 = useTransform(progress, [0, 0.5], col(1));
  const ys = [y0, y1, y2];

  const columns: Project[][] = [
    [projects[1], projects[3], projects[0]],
    [projects[2], projects[4], projects[5]],
    [projects[0], projects[5], projects[3]],
  ];
  const figIndex = [[1, 0, 2], [0, 2, 1], [1, 2, 1]];

  return (
    <motion.div
      data-snap
      className="relative h-[110vw] shrink-0 overflow-hidden bg-charcoal sm:h-[80vw] lg:h-full lg:w-[min(64vw,1100px)]"
      initial={{ clipPath: "inset(0 0 0 100%)" }}
      animate={ready ? { clipPath: "inset(0 0 0 0%)" } : {}}
      transition={{ duration: 1.4, delay: 0.25, ease: EASE_CURTAIN }}
    >
      <div className="grid h-full grid-cols-3 gap-1.5 px-1.5">
        {columns.map((list, c) => (
          <motion.div key={c} style={{ y: ys[c] }} className="flex flex-col gap-1.5 py-1.5">
            {list.map((p, r) => {
              const fig = p.figures[figIndex[c][r]];
              return (
                <Link
                  key={`${p.slug}-${r}`}
                  href={`/projects/${p.slug}`}
                  data-cursor={p.title}
                  className="group relative block flex-1 overflow-hidden bg-[#161616]"
                  style={{ minHeight: r === 1 ? "44%" : "28%" }}
                >
                  <Image
                    src={fig.src}
                    alt={`${p.title}: ${fig.caption}`}
                    fill
                    sizes="(min-width:1024px) 22vw, 33vw"
                    placeholder="blur"
                    className="object-cover transition-transform duration-[1200ms] ease-editorial group-hover:scale-[1.03]"
                  />
                </Link>
              );
            })}
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

/* ——— 3. Chapter title ———————————————————————————————————————— */

function ChapterPanel() {
  const run = "Selected works / 2020 — 2026 / Six buildings / Copenhagen — Lisbon — Reykjavík / ";
  return (
    <div
      data-snap
      className="relative flex shrink-0 flex-col justify-between overflow-hidden border-b py-10 lg:w-[min(40vw,640px)] lg:border-b-0 lg:border-r lg:py-14"
    >
      <div className="overflow-hidden whitespace-nowrap border-y py-3">
        <div className="marquee-l flex w-max" style={{ ["--marquee-duration" as string]: "40s" }}>
          {[0, 1].map((i) => (
            <span key={i} className="label pr-2 text-charcoal">
              {run.repeat(3)}
            </span>
          ))}
        </div>
      </div>

      <div className="px-4 py-16 sm:px-6 lg:px-12 lg:py-0">
        <p className="font-sans text-[clamp(64px,8.4vw,150px)] font-medium uppercase leading-[0.82] tracking-[-0.055em]">
          Works
        </p>
        <div className="mt-4 flex items-end justify-between gap-6">
          <p className="font-sans text-[clamp(40px,4.6vw,84px)] font-light leading-none tracking-[-0.04em]">/26</p>
          <p className="max-w-[220px] text-[12px] leading-relaxed text-mutedText">
            Six projects across four countries: a house, a pavilion, a chapel, an archive and two places to live.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 sm:px-6 lg:px-12">
        <span className="label">Chapter 01</span>
        <span className="label">{String(projects.length).padStart(2, "0")} projects</span>
      </div>
    </div>
  );
}

/* ——— 4. Project panel (desktop) ————————————————————————————— */

function ProjectPanel({ project: p, active, onActivate }: { project: Project; active: boolean; onActivate: () => void }) {
  return (
    <Link
      href={`/projects/${p.slug}`}
      data-snap
      data-cursor="View project"
      onMouseEnter={onActivate}
      onFocus={onActivate}
      className="group relative flex h-full w-[clamp(300px,23vw,400px)] shrink-0 flex-col overflow-hidden border-r px-8 pb-10 pt-[18vh]"
    >
      <motion.div
        aria-hidden
        className="absolute inset-0"
        initial={false}
        animate={{ clipPath: active ? "inset(0% 0% 0% 0%)" : "inset(100% 0% 0% 0%)" }}
        transition={{ duration: 0.9, ease: EASE_CURTAIN }}
      >
        <motion.div
          className="absolute inset-0"
          initial={false}
          animate={{ scale: active ? 1 : 1.15 }}
          transition={{ duration: 1.4, ease: EASE_EDITORIAL }}
        >
          <Image src={p.cover} alt="" fill sizes="25vw" placeholder="blur" className="object-cover" />
        </motion.div>
        <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/10 to-black/55" />
      </motion.div>

      <div
        className={`relative flex h-full flex-col transition-colors duration-700 ease-editorial ${
          active ? "text-canvas" : "text-charcoal"
        }`}
      >
        <div className="flex items-start gap-2">
          <span
            className={`font-sans text-[clamp(72px,6.4vw,112px)] font-semibold leading-[0.8] tracking-[-0.05em] transition-colors duration-700 ease-editorial ${
              active ? "text-canvas" : "text-stoneSubtle"
            }`}
          >
            {p.index}
          </span>
          <span className={`text-[10px] font-medium ${active ? "text-canvas/80" : "text-stoneDeep"}`}>
            ’{String(p.year).slice(2)}
          </span>
        </div>

        <div className={`mt-4 space-y-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${active ? "text-canvas/90" : "text-stoneDeep"}`}>
          <p>
            {p.city} / {p.country}
          </p>
          <p className="font-normal">{p.typology}</p>
          <p className="font-normal">{p.year}</p>
        </div>

        <h2
          className={`mt-auto font-serif text-[clamp(28px,2.3vw,40px)] leading-[1] transition-colors duration-700 ease-editorial ${
            active ? "text-canvas" : "text-stoneDeep"
          }`}
        >
          {p.title}
        </h2>

        <div className="mt-10 flex items-center justify-between">
          <span className={`text-[10px] uppercase tracking-[0.12em] ${active ? "text-canvas/80" : "text-stoneDeep"}`}>
            {p.status}
          </span>
          <span className={`flex items-center gap-3 text-[11px] transition-opacity duration-500 ${active ? "opacity-100" : "opacity-0"}`}>
            See project
            <span className="grid h-6 w-6 place-items-center rounded-full bg-canvas text-[10px] text-charcoal transition-transform duration-500 ease-editorial group-hover:translate-x-1">
              →
            </span>
          </span>
        </div>
      </div>
    </Link>
  );
}

/* ——— 4b. Project card (mobile) ——————————————————————————————— */

function MobileCard({ project: p }: { project: Project }) {
  return (
    <Link href={`/projects/${p.slug}`} className="group block">
      <div className="relative aspect-[4/5] overflow-hidden bg-stoneSubtle">
        <Image src={p.cover} alt={p.title} fill sizes="(min-width:640px) 50vw, 100vw" placeholder="blur" className="object-cover" />
        <span className="absolute left-4 top-3 font-sans text-6xl font-semibold tracking-[-0.05em] text-canvas">{p.index}</span>
      </div>
      <div className="mt-4 flex items-baseline justify-between gap-4 border-t pt-3">
        <h2 className="font-serif text-3xl leading-none">{p.title}</h2>
        <span className="label shrink-0">{p.year}</span>
      </div>
      <p className="label mt-2">
        {p.city}, {p.country} — {p.typology}
      </p>
    </Link>
  );
}

/* ——— 5. End ————————————————————————————————————————————————— */

function EndPanel() {
  return (
    <div data-snap className="flex shrink-0 flex-col justify-between border-t px-4 py-14 sm:px-6 lg:w-[min(34vw,520px)] lg:border-t-0 lg:px-12">
      <p className="label">[ Continue ]</p>
      <Link href="/archive" data-cursor="Open index" className="group my-12 block">
        <span className="font-serif text-[clamp(48px,5vw,88px)] leading-[0.95]">
          The full
          <br />
          <em className="italic">index</em>
          <span className="ml-3 inline-block transition-transform duration-500 ease-editorial group-hover:translate-x-3">→</span>
        </span>
      </Link>
      <p className="max-w-[300px] text-[12px] leading-relaxed text-mutedText">
        Every built work, competition and study since {site.founded}, with drawings and material notes.
      </p>
    </div>
  );
}
