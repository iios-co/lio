/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-2": "var(--bg-2)",
        "bg-highlight": "var(--bg-highlight)",
        surface: "var(--surface)",
        border: "var(--border)",
        "border-bright": "var(--border-bright)",
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
    },
  },
  plugins: [],
};
