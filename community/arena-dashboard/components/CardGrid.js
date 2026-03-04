import { useState, useMemo } from "react";
import WalletCard from "./WalletCard";
import { ACTIVE_THRESHOLD_USD, FLAGGED_WALLET_IDS } from "../lib/constants";

const SORT_OPTIONS = [
  { key: "rank", label: "Rank" },
  { key: "value", label: "Value" },
  { key: "pnl_pct", label: "PnL %" },
  { key: "pnl_usd", label: "PnL $" },
];

export default function CardGrid({ wallets, onSelectWallet, search }) {
  const [sortKey, setSortKey] = useState("rank");
  const [sortAsc, setSortAsc] = useState(true);

  // Split into main (non-flagged) and flagged
  const { mainWallets, flaggedWallets, inactiveCount } = useMemo(() => {
    if (!wallets) return { mainWallets: [], flaggedWallets: [], inactiveCount: 0 };

    const flagged = wallets.filter((w) => FLAGGED_WALLET_IDS.includes(w.id));
    const main = wallets.filter((w) => !FLAGGED_WALLET_IDS.includes(w.id));

    // Re-rank main wallets by value (global rank includes flagged)
    const mainSorted = [...main].sort((a, b) => (b.total_usd || 0) - (a.total_usd || 0));
    mainSorted.forEach((w, i) => {
      w.displayRank = i + 1;
    });

    const activeMain = mainSorted.filter((w) => w.total_usd >= ACTIVE_THRESHOLD_USD);
    const inactive = mainSorted.length - activeMain.length;

    return { mainWallets: activeMain, flaggedWallets: flagged, inactiveCount: inactive };
  }, [wallets]);

  // Apply search + sort to main wallets
  const filtered = useMemo(() => {
    let list = [...mainWallets];

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (w) =>
          String(w.id).includes(q) ||
          w.safe?.toLowerCase().includes(q) ||
          w.owner?.toLowerCase().includes(q) ||
          (w.tokens || []).some((t) => t.symbol?.toLowerCase().includes(q))
      );
    }

    list.sort((a, b) => {
      let va, vb;
      switch (sortKey) {
        case "value":
          va = a.total_usd || 0;
          vb = b.total_usd || 0;
          break;
        case "pnl_pct":
          va = a.pnl_pct ?? -9999;
          vb = b.pnl_pct ?? -9999;
          break;
        case "pnl_usd":
          va = a.pnl_usd ?? -999999;
          vb = b.pnl_usd ?? -999999;
          break;
        default:
          va = a.displayRank || 999;
          vb = b.displayRank || 999;
          break;
      }
      return sortAsc ? va - vb : vb - va;
    });

    return list;
  }, [mainWallets, sortKey, sortAsc, search]);

  // Apply search to flagged wallets
  const filteredFlagged = useMemo(() => {
    let list = [...flaggedWallets].sort((a, b) => (b.total_usd || 0) - (a.total_usd || 0));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (w) =>
          String(w.id).includes(q) ||
          w.safe?.toLowerCase().includes(q) ||
          (w.tokens || []).some((t) => t.symbol?.toLowerCase().includes(q))
      );
    }
    return list;
  }, [flaggedWallets, search]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === "rank");
    }
  };

  return (
    <div>
      {/* Sort pills */}
      <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-1 scrollbar-hide">
        <span className="text-xs text-gray-600 mr-1">Sort by</span>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            className={`sort-pill ${sortKey === opt.key ? "active" : ""}`}
            onClick={() => handleSort(opt.key)}
          >
            {opt.label}
            {sortKey === opt.key && (
              <span className="ml-1">{sortAsc ? "\u25B2" : "\u25BC"}</span>
            )}
          </button>
        ))}
      </div>

      {/* Main card grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5">
        {filtered.map((w, i) => (
          <WalletCard
            key={w.id}
            wallet={{ ...w, rank: w.displayRank }}
            index={i}
            onClick={onSelectWallet}
          />
        ))}
      </div>

      {/* Inactive note */}
      {inactiveCount > 0 && (
        <div className="text-center mt-8 text-xs text-gray-600">
          {inactiveCount} wallet{inactiveCount !== 1 ? "s" : ""} below ${ACTIVE_THRESHOLD_USD} not shown
        </div>
      )}

      {/* Flagged wallets section */}
      {filteredFlagged.length > 0 && (
        <div className="mt-12">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              Flagged Wallets
            </h2>
            <span className="text-[10px] text-gray-600 px-2 py-0.5 rounded-full border border-arena-500/20 bg-arena-800/50">
              Team / No Agent NFT
            </span>
          </div>
          <p className="text-xs text-gray-600 mb-4">
            Excluded from official rankings — team-linked or missing competition NFT.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5 opacity-80">
            {filteredFlagged.map((w, i) => (
              <WalletCard
                key={w.id}
                wallet={w}
                index={filtered.length + i}
                onClick={onSelectWallet}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
