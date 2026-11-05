"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";

import { site } from "@/lib/site";
import { useSplash } from "@/lib/splash-store";
import { EASE_EDITORIAL } from "@/lib/motion";
import Wordmark from "./Wordmark";
import Clock from "./Clock";

/** Fixed left index column (desktop): brand, navigation, ticker, socials. */
export default function Rail() {
  const pathname = usePathname();
  const ready = useSplash((s) => s.done);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--rail)] flex-col justify-between border-r bg-canvas px-8 py-9 lg:flex">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={ready ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 1, ease: EASE_EDITORIAL }}
      >
        <Link href="/" aria-label={`${site.fullName}, home`} className="text-[34px]">
          <Wordmark />
        </Link>
        <p className="label mt-3 max-w-[180px] leading-[15px]">Architecture Office</p>
      </motion.div>

      <nav aria-label="Primary">
        <ul className="space-y-4">
          {site.nav.map((item, i) => {
            const active = pathname.startsWith(item.href) || (item.href === "/archive" && pathname.startsWith("/projects"));
            return (
              <motion.li
                key={item.href}
                initial={{ opacity: 0, x: -10 }}
                animate={ready ? { opacity: 1, x: 0 } : {}}
                transition={{ duration: 0.9, delay: 0.1 + i * 0.07, ease: EASE_EDITORIAL }}
                className="flex items-center gap-3"
              >
                <span
                  className={`h-px bg-charcoal transition-all duration-500 ease-editorial ${active ? "w-5" : "w-0"}`}
                />
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`text-[13px] transition-colors duration-500 ease-editorial ${
                    active ? "text-charcoal" : "text-mutedText hover:text-charcoal"
                  }`}
                >
                  {item.label}
                </Link>
              </motion.li>
            );
          })}
        </ul>
        <Link
          href="/contact"
          className="mt-10 inline-flex h-9 items-center bg-charcoal px-5 text-[11px] font-medium tracking-wide text-canvas transition-all duration-500 ease-editorial hover:px-7"
        >
          Start a project
        </Link>
      </nav>

      <div className="space-y-6">
        <div className="space-y-1 border-t pt-5">
          <p className="label">{site.city}</p>
          <Clock className="block text-[13px]" />
          <p className="label">{site.coordinates}</p>
        </div>
        <div className="flex items-center justify-between">
          <ul className="flex gap-4">
            {site.social.map((s) => (
              <li key={s.label}>
                <a href={s.href} target="_blank" rel="noreferrer" aria-label={s.label} className="label hairline-link hover:text-charcoal">
                  {s.short}
                </a>
              </li>
            ))}
          </ul>
          <span className="label">© {new Date().getFullYear()}</span>
        </div>
      </div>
    </aside>
  );
}
