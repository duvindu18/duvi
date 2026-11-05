"use client";

import { useRef } from "react";
import Image, { type StaticImageData } from "next/image";
import { motion, useScroll, useTransform } from "framer-motion";
import { EASE_EDITORIAL } from "@/lib/motion";

/** Image that drifts slowly inside its frame as the page scrolls past it. */
export default function ParallaxFigure({
  src,
  alt,
  caption,
  number,
  sizes = "(min-width:1024px) 55vw, 100vw",
  priority = false,
  strength = 9,
}: {
  src: StaticImageData;
  alt: string;
  caption?: string;
  number?: string;
  sizes?: string;
  priority?: boolean;
  strength?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [`-${strength}%`, `${strength}%`]);

  return (
    <figure>
      <motion.div
        ref={ref}
        className="group relative overflow-hidden bg-stoneSubtle"
        style={{ aspectRatio: `${src.width} / ${src.height}` }}
        initial={{ clipPath: "inset(8% 0% 0% 0%)", opacity: 0 }}
        whileInView={{ clipPath: "inset(0% 0% 0% 0%)", opacity: 1 }}
        viewport={{ once: true, margin: "-10% 0px" }}
        transition={{ duration: 1.4, ease: EASE_EDITORIAL }}
      >
        <motion.div className="absolute inset-x-0 -inset-y-[12%]" style={{ y }}>
          <Image
            src={src}
            alt={alt}
            fill
            sizes={sizes}
            priority={priority}
            placeholder="blur"
            className="object-cover transition-transform duration-[1400ms] ease-editorial group-hover:scale-[1.03]"
          />
        </motion.div>
      </motion.div>
      {caption && (
        <figcaption className="mt-3 flex gap-4 text-[11px] text-mutedText">
          {number && <span className="tabular-nums text-charcoal">Fig. {number}</span>}
          <span>{caption}</span>
        </figcaption>
      )}
    </figure>
  );
}
