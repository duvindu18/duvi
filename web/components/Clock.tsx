"use client";

import { useEffect, useState } from "react";
import { site } from "@/lib/site";

/** Live studio-local time, e.g. "14:32:07". Renders placeholders on the server. */
export default function Clock({ className = "" }: { className?: string }) {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: site.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const update = () => setNow(fmt.format(new Date()));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <time className={`tabular-nums ${className}`} suppressHydrationWarning>
      {now ?? "--:--:--"}
    </time>
  );
}
