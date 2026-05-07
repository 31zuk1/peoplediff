import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#05070b",
        panel: "#0d121b",
        line: "#223047",
        signal: "#6ee7b7",
        amber: "#f59e0b",
        cyan: "#22d3ee",
        magenta: "#e879f9",
        danger: "#fb7185"
      },
      boxShadow: {
        glow: "0 0 40px rgba(34, 211, 238, 0.12)"
      }
    }
  },
  plugins: []
};

export default config;
