import { TOKEN_COLORS } from "../lib/constants";
import { fmtCompact } from "../lib/formatters";

export default function TokenPill({ symbol, usd }) {
  const color = TOKEN_COLORS[symbol] || "border-arena-400/30 text-gray-300";
  return (
    <span className={`token-pill ${color}`}>
      {symbol}
      {usd > 0 && <span className="text-gray-500 ml-1">{fmtCompact(usd)}</span>}
    </span>
  );
}
