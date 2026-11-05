"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useMotionValue, useSpring } from "framer-motion";

import { projects, typologies } from "@/lib/projects";
import { EASE_EDITORIAL } from "@/lib/motion";
import Reveal from "./Reveal";

const SORTS = ["Year", "Project", "Location"] as const;
type Sort = (typeof SORTS)[number];

export default function ArchiveIndex() {
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("Year");
  const [hovered, setHovered] = useState<number | null>(null);

  // Floating preview follows the pointer on a soft spring.
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 30, mass: 0.6 });
  const sy = useSpring(y, { stiffness: 260, damping: 30, mass: 0.6 });

  const rows = useMemo(() => {
    const list = projects.filter((p) => !filter || p.typology === filter);
    return [...list].sort((a, b) =>
      sort === "Year" ? b.year - a.year : sort === "Project" ? a.title.localeCompare(b.title) : a.city.localeCompare(b.city),
    );
  }, [filter, sort]);

  // Stagger rows in on first paint only; later filter changes respond at once.
  const intro = useRef(true);
  useEffect(() => {
    const id = setTimeout(() => (intro.current = false), 1500);
    return () => clearTimeout(id);
  }, []);

  const preview = hovered === null ? null : projects[hovered];

  return (
    <div
      className="relative min-h-[100svh] px-4 pb-24 pt-12 sm:px-6 lg:px-14 lg:pt-16"
      onPointerMove={(e) => {
        x.set(e.clientX);
        y.set(e.clientY);
      }}
    >
      <header className="grid gap-10 border-b pb-10 lg:grid-cols-12 lg:items-end">
        <div className="lg:col-span-7">
          <p className="label mb-6">[ Index of works ]</p>
          <h1 className="font-display text-[clamp(64px,10vw,168px)] leading-[0.82] tracking-[-0.02em]">
            <Reveal lines={["Index"]} delay={0.4} />
          </h1>
        </div>
        <div className="flex flex-col gap-6 lg:col-span-5 lg:items-end">
          <p className="max-w-[360px] text-[13px] leading-relaxed text-charcoal/75 lg:text-right">
            A complete register of built and ongoing work. Hover a title to preview it; select to open the monograph.
          </p>
          <span className="label tabular-nums">
            {String(rows.length).padStart(2, "0")} / {String(projects.length).padStart(2, "0")} entries
          </span>
        </div>
      </header>

      {/* Filters + sort */}
      <div className="flex flex-col gap-4 border-b py-5 md:flex-row md:items-center md:justify-between">
        <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Filter by typology">
          {[null, ...typologies].map((t) => (
            <li key={t ?? "all"}>
              <button
                type="button"
                onClick={() => setFilter(t)}
                aria-pressed={filter === t}
                className={`caps hairline-link text-[11px] transition-colors duration-500 ease-editorial ${
                  filter === t ? "text-charcoal" : "text-mutedText hover:text-charcoal"
                }`}
                aria-current={filter === t ? "page" : undefined}
              >
                {t ?? "All"}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4">
          <span className="label">Sort</span>
          {SORTS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              aria-pressed={sort === s}
              className={`caps text-[11px] transition-colors duration-500 ease-editorial ${
                sort === s ? "text-charcoal" : "text-mutedText hover:text-charcoal"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Column heads */}
      <div className="label hidden grid-cols-12 gap-6 border-b py-3 md:grid">
        <span className="col-span-1">No.</span>
        <span className="col-span-5">Project</span>
        <span className="col-span-2">Typology</span>
        <span className="col-span-2">Location</span>
        <span className="col-span-1">Status</span>
        <span className="col-span-1 text-right">Year</span>
      </div>

      <ul onPointerLeave={() => setHovered(null)}>
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((p, i) => {
            const idx = projects.indexOf(p);
            const dim = hovered !== null && hovered !== idx;
            return (
              <motion.li
                key={p.slug}
                layout
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.7, delay: intro.current ? 0.5 + i * 0.05 : i * 0.03, ease: EASE_EDITORIAL, layout: { duration: 0.6, ease: EASE_EDITORIAL } }}
                className="border-b"
              >
                <Link
                  href={`/projects/${p.slug}`}
                  onPointerEnter={() => setHovered(idx)}
                  onFocus={() => setHovered(idx)}
                  onBlur={() => setHovered(null)}
                  className={`group grid grid-cols-12 items-baseline gap-x-6 gap-y-2 py-5 transition-opacity duration-500 ease-editorial md:py-6 ${
                    dim ? "opacity-25" : "opacity-100"
                  }`}
                >
                  <span className="label col-span-2 tabular-nums text-charcoal md:col-span-1">{p.index}</span>
                  <span className="col-span-10 font-display text-[clamp(24px,2.8vw,44px)] leading-[1] tracking-[-0.015em] transition-transform duration-700 ease-editorial group-hover:translate-x-3 md:col-span-5">
                    {p.title}
                  </span>
                  <span className="col-span-6 col-start-3 text-[12px] text-mutedText md:col-span-2 md:col-start-auto">{p.typology}</span>
                  <span className="col-span-4 text-[12px] text-mutedText md:col-span-2">
                    {p.city}, {p.country}
                  </span>
                  <span className="hidden text-[12px] text-mutedText md:col-span-1 md:block">{p.status}</span>
                  <span className="hidden text-right text-[12px] tabular-nums md:col-span-1 md:block">{p.year}</span>
                </Link>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {/* Floating cursor preview (fine pointers only) */}
      <motion.div
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-30 hidden [@media(hover:hover)]:block"
        style={{ x: sx, y: sy }}
      >
        <AnimatePresence>
          {preview && (
            <motion.div
              key="frame"
              className="absolute -translate-y-1/2 translate-x-8 overflow-hidden bg-stoneSubtle shadow-[0_30px_60px_-30px_rgba(0,0,0,0.45)]"
              style={{ width: "clamp(220px, 20vw, 340px)", aspectRatio: "4 / 5" }}
              initial={{ opacity: 0, scale: 0.92, clipPath: "inset(12% 12% 12% 12%)" }}
              animate={{ opacity: 1, scale: 1, clipPath: "inset(0% 0% 0% 0%)" }}
              exit={{ opacity: 0, scale: 0.96, clipPath: "inset(8% 8% 8% 8%)" }}
              transition={{ duration: 0.45, ease: EASE_EDITORIAL }}
            >
              {/* Every cover stays mounted; only opacity changes, so swaps are instant. */}
              {projects.map((p, i) => (
                <Image
                  key={p.slug}
                  src={p.cover}
                  alt=""
                  fill
                  sizes="340px"
                  placeholder="blur"
                  className={`object-cover transition-opacity duration-300 ${hovered === i ? "opacity-100" : "opacity-0"}`}
                />
              ))}
              <span className="absolute bottom-3 left-3 caps bg-canvas px-2 py-1 text-[10px] tracking-[0.12em]">
                {preview.index} — {preview.city}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
