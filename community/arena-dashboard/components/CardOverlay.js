import { useEffect, useState } from "react";
import ClawAvatar from "./ClawAvatar";
import RankBadge from "./RankBadge";
import TokenPill from "./TokenPill";
import PieChart from "./PieChart";
import { fmtUsd, fmtPnl, fmtPct } from "../lib/formatters";
import { getCardStyle } from "../lib/cardStyles";
import { TEAM_WALLET_IDS, FLAGGED_WALLET_IDS } from "../lib/constants";

export default function CardOverlay({ wallet, onClose }) {
  const [narrative, setNarrative] = useState(null);
  const [keyMoments, setKeyMoments] = useState([]);

  // Close on Escape
  useEffect(() => {
    if (!wallet) return;
    const handler = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wallet, onClose]);

  // Fetch narrative on open
  useEffect(() => {
    if (!wallet) {
      setNarrative(null);
      setKeyMoments([]);
      return;
    }
    let cancelled = false;
    setNarrative(null);

    fetch(`/api/narrative/${wallet.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setNarrative(data.narrative || "No story available.");
          setKeyMoments(data.keyMoments || []);
        }
      })
      .catch(() => {
        if (!cancelled) setNarrative("Could not load trading story.");
      });

    return () => { cancelled = true; };
  }, [wallet?.id]);

  if (!wallet) return null;

  const {
    id, rank, total_usd, pnl_usd, pnl_pct, tokens,
    deposit_usd, deposit_breakdown, withdrawal_breakdown,
    safe, is_you, has_nft,
  } = wallet;

  const style = getCardStyle(id);
  const isTeam = TEAM_WALLET_IDS.includes(id);
  const isNoNft = FLAGGED_WALLET_IDS.includes(id) && !isTeam;
  const pnlColor = pnl_usd > 0 ? "text-green-400" : pnl_usd < 0 ? "text-red-400" : "text-gray-500";

  return (
    <div className="card-overlay-backdrop" onClick={onClose}>
      <div
        className="card-overlay-content p-5 md:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Top section ── */}
        <div className="flex flex-col md:flex-row gap-6">

          {/* Left: Avatar + Stats */}
          <div className="md:w-2/5 flex flex-col items-center md:items-start">
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 text-xl leading-none"
            >
              &times;
            </button>

            <div className="flex flex-col items-center w-full">
              <ClawAvatar walletId={id} rank={rank} size="lg" />
              <div className="mt-3 text-center">
                <div className="flex items-center justify-center gap-2">
                  <RankBadge rank={rank} />
                  <span className="text-2xl font-bold">#{id}</span>
                </div>
                {style.label && (
                  <div className="text-sm text-gray-500 italic mt-1">{style.label}</div>
                )}
                <div className="flex items-center justify-center gap-1.5 mt-2">
                  {has_nft && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                      NFT Verified
                    </span>
                  )}
                  {is_you && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      Your Wallet
                    </span>
                  )}
                  {isTeam && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
                      Team?
                    </span>
                  )}
                  {isNoNft && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                      No Agent NFT
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Key stats */}
            <div className="w-full mt-5 space-y-2">
              <StatRow label="Value" value={fmtUsd(total_usd)} />
              <StatRow label="Net Deposit" value={fmtUsd(deposit_usd)} />
              <StatRow label="PnL" value={fmtPnl(pnl_usd)} valueClass={pnlColor} />
              <StatRow label="Return" value={fmtPct(pnl_pct)} valueClass={pnlColor} />
            </div>
          </div>

          {/* Right: Narrative + Holdings */}
          <div className="md:w-3/5 space-y-5">

            {/* Key moments timeline */}
            <div className="rounded-lg p-4" style={{ background: "rgba(36, 22, 84, 0.3)", borderLeft: "3px solid rgba(255, 140, 20, 0.3)" }}>
              <div className="text-xs text-gray-500 mb-3 uppercase tracking-wider">Key Moments</div>
              {keyMoments.length > 0 ? (
                <div className="space-y-3">
                  {keyMoments.map((m, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="flex flex-col items-center flex-shrink-0">
                        <span className={`w-2.5 h-2.5 rounded-full ${
                          m.type === "deposit" ? "bg-green-500" :
                          m.type === "airdrop" ? "bg-yellow-500" :
                          m.type === "withdrawal" ? "bg-red-500" :
                          m.type === "trade" ? "bg-neon-green" :
                          "bg-arena-400"
                        }`} />
                        {i < keyMoments.length - 1 && (
                          <div className="w-px h-4 bg-arena-500/30 mt-1" />
                        )}
                      </div>
                      <div className="flex-1 -mt-0.5">
                        <div className="text-sm text-gray-300">{m.text}</div>
                        {m.detail && (
                          <div className="text-xs text-gray-500 mt-0.5">{m.detail}</div>
                        )}
                        <div className="text-[10px] text-gray-600 mt-0.5">{m.dateStr}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : narrative === null ? (
                <p className="text-sm text-gray-600 animate-pulse">Loading timeline...</p>
              ) : (
                <p className="text-sm text-gray-600">No activity recorded yet.</p>
              )}
            </div>

            {/* Pie chart */}
            {tokens && tokens.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Portfolio</div>
                <PieChart tokens={tokens} size={80} />
              </div>
            )}

            {/* Holdings */}
            <div>
              <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Holdings</div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {(tokens || []).map((t, i) => (
                  <div key={i} className="flex justify-between items-center py-1 px-2 rounded hover:bg-arena-700/30 text-sm">
                    <div className="flex items-center gap-2">
                      <TokenPill symbol={t.symbol} usd={0} />
                      <span className="text-gray-500 text-xs">{t.balance?.toFixed(4)}</span>
                    </div>
                    <span className="font-medium text-gray-300">
                      {t.usd_value > 0 ? fmtUsd(t.usd_value) : "$?"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Deposits */}
            {deposit_breakdown && deposit_breakdown.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Deposits</div>
                <div className="text-xs space-y-0.5 text-gray-500">
                  {deposit_breakdown.map((d, i) => (
                    <div key={i}>+ {d}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Withdrawals */}
            {withdrawal_breakdown && withdrawal_breakdown.length > 0 && (
              <div>
                <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Withdrawals</div>
                <div className="text-xs space-y-0.5 text-gray-500">
                  {withdrawal_breakdown.map((w, i) => (
                    <div key={i}>- {w}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Links ── */}
        <div className="flex gap-4 text-xs pt-4 mt-4 border-t border-arena-500/20">
          <a
            href={`https://basescan.org/address/${safe}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-arena-300 hover:text-neon-green/80 transition-colors"
          >
            Basescan &rarr;
          </a>
          <a
            href={`https://app.safe.global/home?safe=base:${safe}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-arena-300 hover:text-neon-green/80 transition-colors"
          >
            Safe App &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value, valueClass = "text-gray-200" }) {
  return (
    <div className="flex justify-between items-center py-1.5 px-3 rounded-lg" style={{ background: "rgba(26, 15, 61, 0.4)" }}>
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}
