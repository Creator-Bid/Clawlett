/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          900: "#0a0a0f",
          800: "#12121a",
          700: "#1a1a27",
          600: "#222233",
        },
        arena: {
          deep: "#0d0618",
          900: "#130b2e",
          800: "#1a0f3d",
          700: "#241654",
          600: "#2e1d6b",
          500: "#3d2782",
          400: "#5b3aad",
          300: "#7c52d4",
        },
        neon: {
          green: "#ff8c14",
          greenDim: "#e07a10",
        },
        accent: {
          blue: "#3b82f6",
          green: "#22c55e",
          red: "#ef4444",
          gold: "#f59e0b",
          purple: "#a855f7",
        },
        rank: {
          gold: "#ffd700",
          silver: "#c0c0c0",
          bronze: "#cd7f32",
        },
      },
      boxShadow: {
        card: "0 4px 20px rgba(0, 0, 0, 0.3)",
        "card-hover": "0 8px 30px rgba(0, 0, 0, 0.5), 0 0 20px rgba(255, 140, 20, 0.08)",
        "card-gold": "0 0 30px rgba(255, 215, 0, 0.25), 0 4px 20px rgba(0, 0, 0, 0.3)",
        "card-silver": "0 0 20px rgba(192, 192, 192, 0.15), 0 4px 20px rgba(0, 0, 0, 0.3)",
        "card-bronze": "0 0 20px rgba(205, 127, 50, 0.15), 0 4px 20px rgba(0, 0, 0, 0.3)",
        neon: "0 0 15px rgba(255, 140, 20, 0.3)",
      },
      animation: {
        "card-enter": "cardEnter 0.5s ease-out forwards",
        "overlay-enter": "overlayEnter 0.3s ease-out",
        "glow-pulse": "glowPulse 3s ease-in-out infinite",
        "fade-in": "fadeIn 0.2s ease-out",
      },
      keyframes: {
        cardEnter: {
          "0%": { opacity: "0", transform: "translateY(24px) scale(0.96)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        overlayEnter: {
          "0%": { opacity: "0", transform: "scale(0.92)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        glowPulse: {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
