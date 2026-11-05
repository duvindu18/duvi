import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif } from "next/font/google";

import "./globals.css";
import { site } from "@/lib/site";
import SplashScreen from "@/components/SplashScreen";
import Rail from "@/components/Rail";
import MobileBar from "@/components/MobileBar";
import CursorLabel from "@/components/CursorLabel";
import Providers from "@/components/Providers";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: `${site.fullName}`, template: `%s — ${site.name}` },
  description: site.description,
};

export const viewport: Viewport = { themeColor: "#FAFAFA" };

// Runs before paint: skip the splash for the rest of the browser session once
// it has been seen, without a flash of the overlay.
const splashGate = `try{if(sessionStorage.getItem("halde:splash"))document.documentElement.dataset.splashSeen="1"}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: splashGate }} />
      </head>
      <body>
        <Providers>
          <SplashScreen />
          <Rail />
          <MobileBar />
          <main className="min-h-[100svh] lg:pl-[var(--rail)]">{children}</main>
          <CursorLabel />
        </Providers>
      </body>
    </html>
  );
}
