/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Tokyo Night palette, referenced via CSS variables so a future light
        // variant only needs to swap the :root values.
        bg: "var(--bg)",
        "bg-dark": "var(--bg-dark)",
        "bg-highlight": "var(--bg-highlight)",
        surface: "var(--surface)",
        border: "var(--border)",
        fg: "var(--fg)",
        "fg-muted": "var(--fg-muted)",
        "fg-subtle": "var(--fg-subtle)",
        blue: "var(--blue)",
        cyan: "var(--cyan)",
        teal: "var(--teal)",
        green: "var(--green)",
        magenta: "var(--magenta)",
        red: "var(--red)",
        orange: "var(--orange)",
        yellow: "var(--yellow)",
      },
      boxShadow: {
        glow: "0 0 0 1px var(--border), 0 8px 30px rgba(0,0,0,0.45)",
        "glow-blue": "0 0 16px rgba(122,162,247,0.35)",
      },
    },
  },
  plugins: [],
};
