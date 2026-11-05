"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring } from "framer-motion";

/**
 * A small floating label that follows the pointer over any element carrying
 * `data-cursor="View"` (or any text). Native cursor stays visible; this only
 * annotates intent. Fine pointers only.
 */
export default function CursorLabel() {
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const sx = useSpring(x, { stiffness: 600, damping: 40, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 600, damping: 40, mass: 0.4 });
  const [label, setLabel] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    setEnabled(mq.matches);
    if (!mq.matches) return;

    const move = (e: PointerEvent) => {
      x.set(e.clientX);
      y.set(e.clientY);
      const el = (e.target as Element | null)?.closest?.("[data-cursor]");
      setLabel(el ? el.getAttribute("data-cursor") : null);
    };
    const leave = () => setLabel(null);
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
    };
  }, [x, y]);

  if (!enabled) return null;

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[90]"
      style={{ x: sx, y: sy }}
    >
      <AnimatePresence>
        {label && (
          <motion.span
            key={label}
            className="absolute ml-4 mt-4 whitespace-nowrap bg-charcoal px-2.5 py-1.5 caps text-[10px] tracking-[0.12em] text-canvas"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.15 }}
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
