import { getCardStyle } from "../lib/cardStyles";

export default function ClawAvatar({ walletId, rank, size = "md" }) {
  const style = getCardStyle(walletId);

  const sizes = {
    sm: { img: "w-14 h-14", glow: "w-16 h-16" },
    md: { img: "w-20 h-20", glow: "w-24 h-24" },
    lg: { img: "w-32 h-32", glow: "w-36 h-36" },
  };

  const s = sizes[size] || sizes.md;
  const scale = rank === 1 ? "scale-110" : "";

  return (
    <div className="relative flex items-center justify-center">
      {/* Glow ring */}
      <div
        className={`claw-glow ${s.glow}`}
        style={{ background: style.glow }}
      />
      {/* Claw image */}
      <img
        src="/claw.svg"
        alt={`Claw #${walletId}`}
        className={`relative ${s.img} object-contain ${scale} transition-transform duration-300`}
        style={{
          filter: `hue-rotate(${style.hue}deg) saturate(1.2) brightness(1.1)`,
        }}
        draggable={false}
      />
    </div>
  );
}
