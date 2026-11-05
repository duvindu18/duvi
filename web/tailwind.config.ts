import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#FAFAFA",
        charcoal: "#0A0A0A",
        stoneSubtle: "#E5E5E2",
        stoneDeep: "#C9C7C1",
        mutedText: "#8A8883",
        hairline: "rgba(0,0,0,0.08)",
      },
      fontFamily: {
        display: ["var(--font-display)", "Helvetica Neue", "Arial", "sans-serif"],
        sans: ["var(--font-sans)", "Helvetica Neue", "Arial", "sans-serif"],
      },
      fontSize: {
        micro: ["10px", { lineHeight: "14px", letterSpacing: "0.14em" }],
        caption: ["11px", { lineHeight: "16px", letterSpacing: "0.06em" }],
      },
      transitionTimingFunction: {
        editorial: "cubic-bezier(0.16, 1, 0.3, 1)",
        curtain: "cubic-bezier(0.76, 0, 0.24, 1)",
      },
      borderColor: { DEFAULT: "rgba(0,0,0,0.08)" },
    },
  },
  plugins: [],
};

export default config;
