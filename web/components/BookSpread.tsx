"use client";

import Image from "next/image";
import { motion } from "framer-motion";

import type { Project } from "@/lib/projects";
import { EASE_EDITORIAL } from "@/lib/motion";

/** The project as an open printed monograph: text page left, full-bleed plate right. */
export default function BookSpread({ project: p }: { project: Project }) {
  const inset = p.figures[1] ?? p.cover;
  const plate = p.figures[2] ?? p.cover;

  return (
    <section className="bg-stoneSubtle px-4 py-20 sm:px-6 lg:px-14 lg:py-32" aria-label="Project text">
      <div className="mx-auto mb-10 flex max-w-[1240px] items-baseline justify-between">
        <p className="label">[ Monograph ]</p>
        <p className="label">pp. {Number(p.index) * 12} — {Number(p.index) * 12 + 1}</p>
      </div>

      <motion.div
        className="relative mx-auto grid max-w-[1240px] bg-[#FBFAF7] shadow-[0_50px_80px_-40px_rgba(0,0,0,0.35)] md:grid-cols-2"
        initial={{ opacity: 0, y: 60 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-15% 0px" }}
        transition={{ duration: 1.4, ease: EASE_EDITORIAL }}
      >
        {/* Left page */}
        <div className="flex flex-col px-6 py-10 sm:px-12 md:px-[7%] md:py-[6%]">
          <p className="mb-8 text-center text-[9px] uppercase tracking-[0.4em] text-mutedText">[ {p.title} ]</p>
          <div className="relative mx-auto aspect-[4/5] w-[62%] overflow-hidden">
            <Image src={inset.src} alt={inset.caption} fill sizes="(min-width:768px) 25vw, 60vw" placeholder="blur" className="object-cover" />
          </div>
          <hr className="my-8 border-black/20" />
          <div className="gap-8 font-serif text-[15px] leading-[1.55] text-charcoal/85 [hyphens:auto] sm:columns-2" style={{ textAlign: "justify" }}>
            {p.narrative.map((para, i) => (
              <p key={i} className={i ? "mt-3 indent-6" : ""}>
                {para}
              </p>
            ))}
          </div>
          <p className="mt-8 text-center font-serif text-[12px] italic text-mutedText">
            {p.title} by Halde Architecture Office — {p.team}
          </p>
        </div>

        {/* Right page: full-bleed plate */}
        <div className="relative min-h-[420px] overflow-hidden">
          <Image src={plate.src} alt={plate.caption} fill sizes="(min-width:768px) 50vw, 100vw" placeholder="blur" className="object-cover" />
        </div>

        {/* Gutter shading */}
        <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-24 -translate-x-1/2 bg-gradient-to-r from-transparent via-black/[0.07] to-transparent md:block" />
      </motion.div>
    </section>
  );
}
