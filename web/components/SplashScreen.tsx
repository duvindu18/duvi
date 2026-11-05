"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { useSplash } from "@/lib/splash-store";
import { EASE_CURTAIN, EASE_EDITORIAL } from "@/lib/motion";
import { site } from "@/lib/site";
import Wordmark from "./Wordmark";

const MIN_DURATION = 2600; // ms the counter takes to reach 100 when assets are ready

type Phase = "count" | "settle" | "exit" | "gone";

/** Splash overlay: three marquee bands of the wordmark running in opposite
 *  directions, a rolling 000→100 counter, then the bands resolve into a single
 *  centred wordmark and the whole sheet lifts away. */
export default function SplashScreen() {
  const finish = useSplash((s) => s.finish);
  const [phase, setPhase] = useState<Phase>("count");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (document.documentElement.dataset.splashSeen) {
      setPhase("gone");
      finish();
      return;
    }
    document.documentElement.style.overflow = "hidden";

    let loaded = document.readyState === "complete";
    const onLoad = () => (loaded = true);
    window.addEventListener("load", onLoad);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduce ? 600 : MIN_DURATION;

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      // Hold at 90 until the window has actually loaded.
      const value = Math.round((loaded ? eased : Math.min(eased, 0.9)) * 100);
      setProgress(value);
      if (value < 100) raf = requestAnimationFrame(tick);
      else setTimeout(() => setPhase("settle"), 250);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("load", onLoad);
    };
  }, [finish]);

  useEffect(() => {
    if (phase === "settle") {
      const id = setTimeout(() => setPhase("exit"), 1100);
      return () => clearTimeout(id);
    }
  }, [phase]);

  const onExited = () => {
    document.documentElement.style.overflow = "";
    try {
      sessionStorage.setItem("halde:splash", "1");
    } catch {}
    setPhase("gone");
    finish();
  };

  return (
    <AnimatePresence onExitComplete={onExited}>
      {phase !== "exit" && phase !== "gone" && (
        <motion.div
          id="splash"
          key="splash"
          role="status"
          aria-label={`Loading ${site.fullName}`}
          className="fixed inset-0 z-[100] overflow-hidden bg-charcoal text-canvas"
          exit={{ y: "-100%" }}
          transition={{ duration: 1.1, ease: EASE_CURTAIN }}
        >
          {/* Three bands (dark / light / dark) above a footer strip holding the counter */}
          <div className="flex h-full flex-col">
            {[0, 1, 2].map((i) => (
              <Band key={i} light={i === 1} reverse={i === 1} phase={phase} index={i} />
            ))}
            <motion.div
              className="flex shrink-0 items-end justify-between border-t border-white/10 bg-charcoal px-6 pb-5 pt-4 md:px-10 md:pb-7"
              animate={phase === "settle" ? { y: "100%" } : { y: "0%" }}
              transition={{ duration: 0.8, ease: EASE_CURTAIN }}
            >
              <div className="space-y-1">
                <p className="label text-canvas/50">Loading</p>
                <p className="label text-canvas">Selected works 2020 — 2026</p>
              </div>
              <div className="flex items-end gap-2">
                <Counter value={progress} />
                <span className="mb-1 text-sm font-light">%</span>
              </div>
            </motion.div>
          </div>

          {/* Resolved state: one light sheet with the centred wordmark */}
          <motion.div
            className="absolute inset-0 flex flex-col items-center justify-center bg-canvas text-charcoal"
            initial={{ clipPath: "inset(33.4% 0% 33.4% 0%)", opacity: 0 }}
            animate={
              phase === "settle"
                ? { clipPath: "inset(0% 0% 0% 0%)", opacity: 1 }
                : { clipPath: "inset(33.4% 0% 33.4% 0%)", opacity: 0 }
            }
            transition={{ duration: 0.9, ease: EASE_CURTAIN }}
          >
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={phase === "settle" ? { y: 0, opacity: 1 } : {}}
              transition={{ duration: 1, delay: 0.2, ease: EASE_EDITORIAL }}
              className="text-[clamp(64px,13vw,200px)]"
            >
              <Wordmark />
            </motion.div>
            <motion.p
              initial={{ opacity: 0 }}
              animate={phase === "settle" ? { opacity: 1 } : {}}
              transition={{ duration: 0.8, delay: 0.45 }}
              className="label absolute bottom-10 text-center leading-5"
            >
              {site.tagline}
              <br />
              {site.city} — Est. {site.founded}
            </motion.p>
          </motion.div>

          {/* Metadata, difference-blended so it reads on both bands */}
          <div className="pointer-events-none absolute inset-0 text-white mix-blend-difference">
            <div className="flex justify-between p-6 md:p-10">
              <span className="label text-white">{site.fullName}</span>
              <span className="label hidden text-white sm:block">{site.coordinates}</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Band({
  light,
  reverse,
  phase,
  index,
}: {
  light: boolean;
  reverse: boolean;
  phase: Phase;
  index: number;
}) {
  // Outer bands slide away vertically as the sheet resolves.
  const away = index === 0 ? "-100%" : index === 2 ? "100%" : "0%";
  return (
    <motion.div
      className={`relative flex flex-1 items-center overflow-hidden ${
        light ? "bg-canvas text-charcoal" : "bg-charcoal text-canvas"
      }`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, y: phase === "settle" ? away : "0%" }}
      transition={{
        opacity: { duration: 0.8, delay: 0.15 * index },
        y: { duration: 0.9, ease: EASE_CURTAIN },
      }}
    >
      <div
        className={`flex shrink-0 whitespace-nowrap ${reverse ? "marquee-r" : "marquee-l"}`}
        style={{ ["--marquee-duration" as string]: `${18 + index * 4}s` }}
      >
        {Array.from({ length: 10 }).map((_, i) => (
          <span key={i} className="px-[3vw] text-[clamp(56px,19vh,220px)] leading-none">
            <Wordmark />
          </span>
        ))}
      </div>
    </motion.div>
  );
}

/** Odometer-style counter: each digit is a vertical strip that rolls. */
function Counter({ value }: { value: number }) {
  const digits = String(value).padStart(3, "0").split("");
  return (
    <div className="flex font-sans text-[clamp(48px,6vw,88px)] font-light leading-none tabular-nums tracking-tight">
      {digits.map((d, i) => (
        <span key={i} className="relative inline-block h-[1em] w-[0.62em] overflow-hidden">
          <span
            className="absolute left-0 top-0 flex flex-col transition-transform duration-500 ease-editorial"
            style={{ transform: `translateY(-${Number(d)}em)` }}
          >
            {Array.from({ length: 10 }).map((_, n) => (
              <span key={n} className="h-[1em]">
                {n}
              </span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}
