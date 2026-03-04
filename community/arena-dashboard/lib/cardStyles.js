// Per-wallet CSS differentiation for the claw avatar and card styling.
// Top wallets get manually curated styles; rest auto-generated.

const WALLET_STYLES = {
  20: { hue: 0,   glow: "#39ff14", label: "The Champion" },
  36: { hue: 180, glow: "#14d4ff", label: "CWIF Conviction" },
  35: { hue: 270, glow: "#d414ff", label: "The Insider" },
  22: { hue: 30,  glow: "#ff9914", label: "BID Holder" },
  41: { hue: 120, glow: "#14ff8b", label: "PULSE Hunter" },
  3:  { hue: 320, glow: "#ff1493", label: "Early Bird" },
  16: { hue: 210, glow: "#3b82f6", label: "Senti" },
  15: { hue: 60,  glow: "#e6ff14", label: "The Explorer" },
  31: { hue: 150, glow: "#14ffd4", label: "Down Bad" },
  18: { hue: 240, glow: "#8b14ff", label: "The Steady Hand" },
};

export function getCardStyle(walletId) {
  if (WALLET_STYLES[walletId]) {
    return WALLET_STYLES[walletId];
  }

  // Auto-generate: distribute hue evenly based on wallet ID
  const hue = (walletId * 47) % 360;
  return {
    hue,
    glow: `hsl(${hue}, 80%, 55%)`,
    label: null,
  };
}
