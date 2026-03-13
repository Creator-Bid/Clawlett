// Format USD (no cents)
export function fmtUsd(val) {
  if (val == null) return "\u2014";
  return "$" + Math.round(val).toLocaleString("en-US");
}

// Format PnL with sign (no cents)
export function fmtPnl(val) {
  if (val == null) return "\u2014";
  const sign = val >= 0 ? "+" : "";
  return sign + Math.round(val).toLocaleString("en-US");
}

export function fmtPct(val) {
  if (val == null) return "\u2014";
  const sign = val >= 0 ? "+" : "";
  return sign + val.toFixed(1) + "%";
}

// Truncate address
export function truncAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// Time ago
export function timeAgo(isoStr) {
  if (!isoStr) return "";
  const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

// Compact number for token values
export function fmtCompact(val) {
  if (val == null || val === 0) return "$0";
  if (val < 1) return "<$1";
  if (val < 1000) return "$" + val.toFixed(0);
  if (val < 100000) return "$" + (val / 1000).toFixed(1) + "k";
  return "$" + (val / 1000).toFixed(0) + "k";
}
