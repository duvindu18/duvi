"use client";

import { motion } from "framer-motion";
import { EASE_CURTAIN, EASE_EDITORIAL } from "@/lib/motion";

// Re-mounts on every navigation: a charcoal curtain wipes upward off the page
// while the new content fades in underneath it. (Opacity only: a transform
// here would break position:fixed descendants such as the cursor preview.)
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <>
      <motion.div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[60] bg-charcoal"
        initial={{ y: "0%" }}
        animate={{ y: "-100%" }}
        transition={{ duration: 0.85, ease: EASE_CURTAIN }}
      />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.1, delay: 0.35, ease: EASE_EDITORIAL }}
      >
        {children}
      </motion.div>
    </>
  );
}
