"use client";

import { motion } from "framer-motion";
import { EASE_EDITORIAL } from "@/lib/motion";

/** Masked line-by-line reveal: each line rises out of its own clipping box. */
export default function Reveal({
  lines,
  play = true,
  delay = 0,
  stagger = 0.08,
  className = "",
  lineClassName = "",
}: {
  lines: React.ReactNode[];
  play?: boolean;
  delay?: number;
  stagger?: number;
  className?: string;
  lineClassName?: string;
}) {
  return (
    <span className={className}>
      {lines.map((line, i) => (
        <span key={i} className="block overflow-hidden pb-[0.08em]">
          <motion.span
            className={`block ${lineClassName}`}
            initial={{ y: "110%" }}
            animate={play ? { y: "0%" } : { y: "110%" }}
            transition={{ duration: 1.2, delay: delay + i * stagger, ease: EASE_EDITORIAL }}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </span>
  );
}
