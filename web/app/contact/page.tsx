import type { Metadata } from "next";

import { site } from "@/lib/site";
import Reveal from "@/components/Reveal";
import Clock from "@/components/Clock";

export const metadata: Metadata = { title: "Contact" };

const offices = [
  { city: "Copenhagen", lines: site.address, note: "Main studio" },
  { city: "Lisbon", lines: ["Rua da Boavista 84", "1200-066 Lisboa", "Portugal"], note: "Satellite office" },
];

export default function ContactPage() {
  return (
    <div className="flex min-h-[calc(100svh-3.5rem)] flex-col justify-between px-4 pb-12 pt-12 sm:px-6 lg:min-h-[100svh] lg:px-14 lg:pt-16">
      <div>
        <p className="label mb-6">[ Contact ]</p>
        <h1 className="font-display text-[clamp(42px,6vw,108px)] leading-[0.9] tracking-[-0.02em]">
          <Reveal delay={0.4} lines={["Begin with", <em key="c">a conversation.</em>]} />
        </h1>
      </div>

      <div className="mt-20 grid gap-12 border-t pt-10 md:grid-cols-12">
        <div className="md:col-span-5">
          <p className="label mb-3">New projects</p>
          <a
            href={`mailto:${site.email}`}
            className="hairline-link font-display text-[clamp(24px,2.4vw,38px)] normal-case leading-tight"
          >
            {site.email}
          </a>
          <p className="mt-3 text-[13px]">{site.phone}</p>
          <p className="mt-6 max-w-[360px] text-[13px] leading-relaxed text-mutedText">
            We take on four to six new commissions a year. Tell us about the site, the people who will use it, and
            the timeframe you have in mind.
          </p>
        </div>

        {offices.map((o) => (
          <div key={o.city} className="md:col-span-3">
            <p className="label mb-3">{o.note}</p>
            <p className="mt-1 font-display text-xl font-bold">{o.city}</p>
            <address className="mt-2 text-[13px] not-italic leading-relaxed text-charcoal/75">
              {o.lines.map((l) => (
                <span key={l} className="block">
                  {l}
                </span>
              ))}
            </address>
          </div>
        ))}

        <div className="flex items-end justify-between border-t pt-6 md:col-span-12">
          <p className="label">
            Local time — <Clock className="text-charcoal" />
          </p>
          <ul className="flex gap-6">
            {site.social.map((s) => (
              <li key={s.label}>
                <a href={s.href} target="_blank" rel="noreferrer" className="caps hairline-link text-[11px]">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
