const COLORS = [
  "#39ff14", "#3b82f6", "#f59e0b", "#a855f7", "#ef4444",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
];

export default function PieChart({ tokens, size = 96 }) {
  const total = tokens.reduce((s, t) => s + (t.usd_value || 0), 0);
  if (total === 0) return null;

  let angle = 0;
  const segments = tokens
    .filter((t) => t.usd_value > 0)
    .map((t, i) => {
      const pct = (t.usd_value / total) * 360;
      const start = angle;
      angle += pct;
      return `${COLORS[i % COLORS.length]} ${start}deg ${angle}deg`;
    });

  const gradient = `conic-gradient(${segments.join(", ")})`;

  return (
    <div className="flex items-center gap-4">
      <div
        className="rounded-full flex-shrink-0"
        style={{ background: gradient, width: size, height: size }}
      />
      <div className="flex flex-col gap-1 text-xs">
        {tokens
          .filter((t) => t.usd_value > 0)
          .slice(0, 8)
          .map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: COLORS[i % COLORS.length] }}
              />
              <span className="text-gray-300">{t.symbol}</span>
              <span className="text-gray-500">{((t.usd_value / total) * 100).toFixed(1)}%</span>
            </div>
          ))}
      </div>
    </div>
  );
}
