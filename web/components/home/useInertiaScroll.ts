"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Turns a horizontally overflowing container into an inertia-driven track on
 * desktop: vertical wheel / trackpad input is mapped to horizontal travel,
 * eased with a lerp, and snapped to the nearest `[data-snap]` child once the
 * input settles. Below `minWidth` the container is left to native scrolling.
 */
export function useInertiaScroll<T extends HTMLElement>(minWidth = 1024) {
  const ref = useRef<T>(null);
  const target = useRef(0);
  const kickRef = useRef<() => void>(() => {});

  const snapPoints = useCallback(() => {
    const el = ref.current;
    if (!el) return [0];
    const max = el.scrollWidth - el.clientWidth;
    const pts = Array.from(el.querySelectorAll<HTMLElement>("[data-snap]")).map((n) => Math.min(n.offsetLeft, max));
    return Array.from(new Set([...pts, max])).sort((a, b) => a - b);
  }, []);

  const go = useCallback(
    (dir: 1 | -1) => {
      const pts = snapPoints();
      const cur = target.current;
      const next = dir > 0 ? pts.find((p) => p > cur + 4) : [...pts].reverse().find((p) => p < cur - 4);
      if (next !== undefined) {
        target.current = next;
        kickRef.current();
      }
    },
    [snapPoints],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let current = el.scrollLeft;
    target.current = current;
    let raf = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let driving = false;

    const max = () => el.scrollWidth - el.clientWidth;
    const clamp = (v: number) => Math.max(0, Math.min(max(), v));

    const loop = () => {
      const t = target.current;
      current += (t - current) * (reduce ? 1 : 0.085);
      if (Math.abs(t - current) < 0.5) current = t;
      driving = true;
      el.scrollLeft = current;
      raf = current !== t ? requestAnimationFrame(loop) : 0;
      if (!raf) requestAnimationFrame(() => (driving = false));
    };
    const kick = () => {
      target.current = clamp(target.current);
      if (!raf) raf = requestAnimationFrame(loop);
    };
    kickRef.current = kick;

    const snap = () => {
      const pts = snapPoints();
      const t = target.current;
      target.current = pts.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), pts[0]);
      kick();
    };

    const onWheel = (e: WheelEvent) => {
      if (!mq.matches || e.ctrlKey) return;
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      target.current = clamp(target.current + d * (e.deltaMode === 1 ? 32 : 1) * 1.15);
      kick();
      clearTimeout(idle);
      idle = setTimeout(snap, 180);
    };

    // Native scrolling (touch, scrollbar drag, keyboard focus) resyncs the lerp.
    const onScroll = () => {
      if (driving) return;
      current = target.current = el.scrollLeft;
    };

    const onKey = (e: KeyboardEvent) => {
      if (!mq.matches) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (["ArrowRight", "PageDown"].includes(e.key) || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        go(1);
      } else if (["ArrowLeft", "PageUp"].includes(e.key) || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        go(-1);
      }
    };

    const onResize = () => {
      target.current = clamp(target.current);
      kick();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(idle);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [go, minWidth, snapPoints]);

  return { ref, next: () => go(1), prev: () => go(-1) };
}
