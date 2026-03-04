import { useState, useEffect } from "react";
import { fmtUsd, timeAgo } from "../lib/formatters";
import { COMPETITION_END, REFRESH_INTERVAL } from "../lib/constants";

function getCountdown() {
  const diff = new Date(COMPETITION_END).getTime() - Date.now();
  if (diff <= 0) return "Competition ended";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  return `${d}d ${h}h remaining`;
}

function getNextUpdate() {
  const now = new Date();
  // Cron runs at 0, 4, 8, 12, 16, 20 UTC
  const nextHour = Math.ceil(now.getUTCHours() / 4) * 4;
  const next = new Date(now);
  next.setUTCHours(nextHour, 0, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 4);
  const diff = next - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function ArenaHeader({ data, countdown, search, onSearchChange }) {
  const [compCountdown, setCompCountdown] = useState(getCountdown());
  const [nextUpdate, setNextUpdate] = useState(getNextUpdate());

  useEffect(() => {
    const t = setInterval(() => {
      setCompCountdown(getCountdown());
      setNextUpdate(getNextUpdate());
    }, 60000);
    return () => clearInterval(t);
  }, []);

  const topWallet = data?.wallets?.[0];
  const totalValue =
    data?.wallets?.reduce((s, w) => s + (w.total_usd || 0), 0) || 0;

  return (
    <header className="border-b border-arena-500/20 sticky top-0 z-40" style={{ background: "rgba(13, 6, 24, 0.85)", backdropFilter: "blur(12px)" }}>
      <div className="max-w-7xl mx-auto px-4 py-4">
        {/* Title row */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              <span className="text-neon">Clawlett</span>{" "}
              <span className="text-gray-200">Arena</span>
            </h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-0.5">
              CreatorBid AI Trading Competition &middot; Base Chain
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs text-neon-green font-medium">
              {compCountdown}
            </div>
            <div className="text-[10px] text-gray-600 mt-0.5">
              {data?.generated_at && <span>Updated {timeAgo(data.generated_at)}</span>}
              <span className="ml-2">{countdown}s</span>
            </div>
            <div className="text-[10px] text-gray-600 mt-0.5">
              Next data refresh in <span className="text-neon-green/70">{nextUpdate}</span>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          {data && (
            <>
              <Stat label="Competitors" value={data.total_wallets} />
              <Stat label="Active" value={data.active_wallets} />
              <Stat
                label="Top Wallet"
                value={topWallet ? fmtUsd(topWallet.total_usd) : "\u2014"}
              />
              <Stat label="Total Value" value={fmtUsd(totalValue)} />
              {data.eth_price && (
                <Stat
                  label="ETH"
                  value={"$" + Math.round(data.eth_price).toLocaleString()}
                />
              )}
            </>
          )}

          {/* Search */}
          <div className="ml-auto">
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-40 sm:w-52 bg-arena-800 border border-arena-500/30 rounded-full px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-neon-green/30 transition-colors"
            />
          </div>
        </div>
      </div>
    </header>
  );
}

function Stat({ label, value }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs" style={{ background: "rgba(26, 15, 61, 0.5)", border: "1px solid rgba(61, 39, 130, 0.2)" }}>
      <span className="text-gray-500">{label}</span>
      <span className="font-semibold text-gray-200">{value}</span>
    </div>
  );
}
