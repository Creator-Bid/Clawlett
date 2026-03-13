import ClawAvatar from "./ClawAvatar";
import RankBadge from "./RankBadge";
import TokenPill from "./TokenPill";
import { getCardStyle } from "../lib/cardStyles";
import { fmtUsd, fmtPct } from "../lib/formatters";
import { TEAM_WALLET_IDS, FLAGGED_WALLET_IDS, USER_WALLET_ID } from "../lib/constants";

export default function WalletCard({ wallet, index, onClick }) {
  const { id, rank, total_usd, pnl_pct, pnl_usd, tokens, is_you } = wallet;
  const isTeam = TEAM_WALLET_IDS.includes(id);
  const isNoNft = FLAGGED_WALLET_IDS.includes(id) && !isTeam;
  const style = getCardStyle(id);

  // Rank-specific card class
  let rankClass = "";
  if (rank === 1) rankClass = "wallet-card--rank-1";
  else if (rank === 2) rankClass = "wallet-card--rank-2";
  else if (rank === 3) rankClass = "wallet-card--rank-3";
  if (is_you) rankClass += " wallet-card--you";

  const pnlColor =
    pnl_pct > 0 ? "text-green-400" : pnl_pct < 0 ? "text-red-400" : "text-gray-500";

  return (
    <div
      className={`wallet-card ${rankClass}`}
      style={{ animationDelay: `${index * 70}ms` }}
      onClick={() => onClick(wallet)}
    >
      {/* Top bar: rank + badges */}
      <div className="flex items-center justify-between px-4 pt-4">
        <RankBadge rank={rank} />
        <div className="flex items-center gap-1.5">
          {is_you && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/25">
              YOU
            </span>
          )}
          {isTeam && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/25">
              TEAM?
            </span>
          )}
          {isNoNft && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/25">
              NO NFT
            </span>
          )}
        </div>
      </div>

      {/* Avatar */}
      <div className="flex justify-center py-4">
        <ClawAvatar walletId={id} rank={rank} size="md" />
      </div>

      {/* Wallet number + label */}
      <div className="text-center px-4">
        <div className="text-xl font-bold tracking-tight">#{id}</div>
        {style.label && (
          <div className="text-[11px] text-gray-500 mt-0.5 italic">{style.label}</div>
        )}
      </div>

      {/* Stats */}
      <div className="px-4 pt-3 pb-2">
        {/* Value */}
        <div className="text-center">
          <div className="text-lg font-bold tracking-tight">{fmtUsd(total_usd)}</div>
          <div className={`text-sm font-semibold ${pnlColor}`}>
            {fmtPct(pnl_pct)}
          </div>
        </div>
      </div>

      {/* Top tokens */}
      <div className="px-4 pb-4 pt-1">
        <div className="flex flex-wrap gap-1 justify-center">
          {(tokens || []).slice(0, 3).map((t, i) => (
            <TokenPill key={i} symbol={t.symbol} usd={t.usd_value} />
          ))}
          {(tokens || []).length > 3 && (
            <span className="text-[10px] text-gray-600 self-center">
              +{tokens.length - 3}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
