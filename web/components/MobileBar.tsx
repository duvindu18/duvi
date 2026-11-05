"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

import { site } from "@/lib/site";
import { EASE_CURTAIN, EASE_EDITORIAL } from "@/lib/motion";
import Wordmark from "./Wordmark";
import Clock from "./Clock";

/** Top bar + full-screen menu for viewports below the desktop rail. */
export default function MobileBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b bg-canvas/90 px-4 backdrop-blur-md sm:px-6 lg:hidden">
        <Link href="/" className="text-[26px]" aria-label={`${site.fullName}, home`}>
          <Wordmark />
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-menu"
          className="flex h-10 items-center gap-3 text-[12px]"
        >
          <span>{open ? "Close" : "Menu"}</span>
          <span className="relative block h-2 w-5">
            <span className={`absolute left-0 h-px w-full bg-charcoal transition-all duration-500 ease-editorial ${open ? "top-1 rotate-45" : "top-0"}`} />
            <span className={`absolute left-0 h-px w-full bg-charcoal transition-all duration-500 ease-editorial ${open ? "top-1 -rotate-45" : "top-2"}`} />
          </span>
        </button>
      </header>
      <div className="h-14 lg:hidden" />

      <AnimatePresence>
        {open && (
          <motion.div
            id="mobile-menu"
            className="fixed inset-0 top-14 z-40 flex flex-col justify-between bg-canvas px-4 pb-8 pt-10 sm:px-6 lg:hidden"
            initial={{ clipPath: "inset(0 0 100% 0)" }}
            animate={{ clipPath: "inset(0 0 0% 0)" }}
            exit={{ clipPath: "inset(0 0 100% 0)" }}
            transition={{ duration: 0.7, ease: EASE_CURTAIN }}
          >
            <nav aria-label="Primary">
              <ul>
                {[{ href: "/", label: "Home" }, ...site.nav].map((item, i) => (
                  <motion.li
                    key={item.href}
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.15 + i * 0.06, ease: EASE_EDITORIAL }}
                    className="border-b"
                  >
                    <Link href={item.href} className="flex items-baseline justify-between py-4">
                      <span className="font-serif text-5xl">{item.label}</span>
                      <span className="label">0{i + 1}</span>
                    </Link>
                  </motion.li>
                ))}
              </ul>
            </nav>
            <div className="flex items-end justify-between">
              <div>
                <p className="label">{site.city}</p>
                <Clock className="text-sm" />
              </div>
              <a href={`mailto:${site.email}`} className="text-sm">{site.email}</a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
