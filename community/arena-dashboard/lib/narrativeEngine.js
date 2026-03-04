/**
 * narrativeEngine.js — Server-side trading story generator.
 *
 * Analyzes wallet history + deposit data to produce a short,
 * casual storyteller narrative for each wallet.
 */

// ── Helpers ──

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  if (n >= 1) return n.toFixed(0);
  return n.toFixed(2);
}

function fmtUsd(n) {
  return "$" + fmt(n);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Style Classification ──

function classifyStyle(swaps, uniqueTokens) {
  const count = swaps.length;
  if (count === 0) return "holder";
  if (count <= 5 && uniqueTokens <= 2) return "conviction";
  if (count <= 10) return "casual";
  if (uniqueTokens >= 8) return "explorer";
  if (count > 60) return "hyperactive";
  return "active";
}

// ── Extract Swaps from History ──

function extractSwaps(txHistory, safe) {
  const safeLower = safe.toLowerCase();
  const swaps = [];
  const tokensBought = {};
  const tokensSold = {};

  for (const tx of txHistory) {
    const cat = (tx.category || "").toLowerCase();
    if (cat !== "token swap") continue;

    const transfers = tx.erc20_transfers || [];
    const bought = [];
    const sold = [];

    for (const t of transfers) {
      const from = (t.from_address || "").toLowerCase();
      const to = (t.to_address || "").toLowerCase();
      const sym = t.token_symbol || t.token_name || "???";
      const amount = parseFloat(t.value_formatted || 0);

      if (to === safeLower && from !== safeLower) {
        bought.push({ symbol: sym, amount, address: (t.address || "").toLowerCase() });
        tokensBought[sym] = (tokensBought[sym] || 0) + 1;
      } else if (from === safeLower && to !== safeLower) {
        sold.push({ symbol: sym, amount, address: (t.address || "").toLowerCase() });
        tokensSold[sym] = (tokensSold[sym] || 0) + 1;
      }
    }

    // Also check native transfers in swaps
    for (const nt of (tx.native_transfers || [])) {
      const from = (nt.from_address || "").toLowerCase();
      const to = (nt.to_address || "").toLowerCase();
      let val = parseFloat(nt.value_formatted || nt.value || 0);
      if (val > 1e15) val = val / 1e18;

      if (to === safeLower && from !== safeLower) {
        bought.push({ symbol: "ETH", amount: val });
      } else if (from === safeLower && to !== safeLower) {
        sold.push({ symbol: "ETH", amount: val });
      }
    }

    if (bought.length > 0 || sold.length > 0) {
      swaps.push({
        timestamp: tx.block_timestamp,
        block: parseInt(tx.block_number || 0),
        summary: tx.summary || "",
        bought,
        sold,
      });
    }
  }

  const allTokens = new Set([...Object.keys(tokensBought), ...Object.keys(tokensSold)]);

  return { swaps, tokensBought, tokensSold, uniqueTokens: allTokens.size };
}

// ── Key Moments ──

function extractKeyMoments(deposits, withdrawals, airdrops, swaps) {
  const moments = [];

  // ── All deposits individually ──
  for (const d of deposits) {
    moments.push({
      date: d.timestamp,
      text: `Deposited ${fmtUsd(d.usd)} in ${d.type}`,
      detail: deposits.length > 1 ? `Deposit ${deposits.indexOf(d) + 1} of ${deposits.length}` : "Initial funding",
      type: "deposit",
    });
  }

  // ── First trade ──
  if (swaps.length > 0) {
    const s = swaps[0];
    const boughtStr = s.bought.map((b) => b.symbol).join(", ");
    const soldStr = s.sold.map((b) => b.symbol).join(", ");
    let text = "First trade";
    let detail = null;
    if (soldStr && boughtStr) {
      text = `Swapped ${soldStr} → ${boughtStr}`;
      detail = "Opening move";
    } else if (s.summary) {
      text = s.summary;
    }
    moments.push({ date: s.timestamp, text, detail, type: "trade" });
  }

  // ── Most traded token ──
  if (swaps.length > 3) {
    const tokenCounts = {};
    for (const s of swaps) {
      for (const b of s.bought) tokenCounts[b.symbol] = (tokenCounts[b.symbol] || 0) + 1;
      for (const b of s.sold) tokenCounts[b.symbol] = (tokenCounts[b.symbol] || 0) + 1;
    }
    // Exclude ETH/WETH — those are routing tokens
    delete tokenCounts["ETH"];
    delete tokenCounts["WETH"];
    const sorted = Object.entries(tokenCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      const [topToken, count] = sorted[0];
      // Place this at the midpoint of trading activity
      const midIdx = Math.floor(swaps.length / 2);
      moments.push({
        date: swaps[midIdx].timestamp,
        text: `Most traded: ${topToken} (${count} swaps)`,
        detail: `${swaps.length} total trades across ${Object.keys(tokenCounts).length + 2} tokens`,
        type: "trade",
      });
    }
  }

  // ── Latest trade ──
  if (swaps.length > 1) {
    const last = swaps[swaps.length - 1];
    const boughtStr = last.bought.map((b) => b.symbol).join(", ");
    const soldStr = last.sold.map((b) => b.symbol).join(", ");
    let text = "Latest trade";
    if (soldStr && boughtStr) text = `Last move: ${soldStr} → ${boughtStr}`;
    const daysSince = Math.floor((Date.now() - new Date(last.timestamp).getTime()) / 86400000);
    const detail = daysSince === 0 ? "Today" : daysSince === 1 ? "Yesterday" : `${daysSince} days ago`;
    moments.push({ date: last.timestamp, text, detail, type: "trade" });
  }

  // ── CLAWLETT airdrop ──
  if (airdrops.length > 0) {
    const totalAmount = airdrops.reduce((s, a) => s + a.amount, 0);
    moments.push({
      date: airdrops[0].timestamp,
      text: `Received ${fmt(totalAmount)} CLAWLETT airdrop`,
      detail: "Ecosystem reward",
      type: "airdrop",
    });
  }

  // ── Withdrawals ──
  for (const w of withdrawals) {
    moments.push({
      date: w.timestamp,
      text: `Withdrew ${fmtUsd(w.usd)} in ${w.type}`,
      detail: null,
      type: "withdrawal",
    });
  }

  moments.sort((a, b) => new Date(a.date) - new Date(b.date));

  return moments.map((m) => ({
    ...m,
    dateStr: fmtDate(m.date),
  }));
}

// ── Narrative Builder ──

function buildNarrative(wallet, depositData, swapData) {
  const parts = [];
  const { swaps, tokensBought, tokensSold, uniqueTokens } = swapData;
  const style = classifyStyle(swaps, uniqueTokens);

  const deposits = depositData.deposits || [];
  const withdrawals = depositData.withdrawals || [];
  const airdrops = depositData.airdrops || [];
  const netDeposit = depositData.net_deposits || 0;

  // ── Opening: how they entered ──
  if (deposits.length === 0) {
    parts.push("Showed up to the arena but never funded the safe.");
  } else if (deposits.length === 1) {
    const d = deposits[0];
    parts.push(`Entered the arena with a ${fmtUsd(d.usd)} ${d.type} deposit.`);
  } else {
    parts.push(
      `Funded the safe across ${deposits.length} deposits, putting in ${fmtUsd(netDeposit)} net capital.`
    );
  }

  // ── Middle: what they did ──
  const topHolding = (wallet.tokens || [])[0];
  const topSymbol = topHolding?.symbol || "tokens";

  switch (style) {
    case "holder":
      parts.push(
        "Took the diamond hands approach \u2014 deposited and held without making a single swap."
      );
      break;
    case "conviction":
      parts.push(
        `Went heavy on ${topSymbol} with conviction \u2014 the kind of trader who picks a lane and commits.`
      );
      break;
    case "casual":
      parts.push(
        `Made ${swaps.length} calculated trades, keeping it measured and deliberate.`
      );
      break;
    case "explorer":
      parts.push(
        `Explored widely \u2014 ${uniqueTokens} different tokens across ${swaps.length} trades. Curious and diversified.`
      );
      break;
    case "hyperactive":
      parts.push(
        `One of the most active traders with ${swaps.length} swaps. Always moving, always adjusting positions.`
      );
      break;
    case "active":
      parts.push(
        `Ran an active strategy with ${swaps.length} trades across ${uniqueTokens} tokens.`
      );
      break;
  }

  // ── Top position context ──
  if (topHolding && topHolding.usd_value > 50) {
    const pctOfPortfolio = wallet.total_usd > 0
      ? ((topHolding.usd_value / wallet.total_usd) * 100).toFixed(0)
      : 0;
    if (pctOfPortfolio > 80) {
      parts.push(
        `Portfolio is ${pctOfPortfolio}% concentrated in ${topSymbol} \u2014 a true maximalist.`
      );
    } else if (pctOfPortfolio > 50) {
      parts.push(
        `Biggest bet is ${topSymbol} at ${pctOfPortfolio}% of the portfolio.`
      );
    }
  }

  // ── Outcome ──
  const pnl = wallet.pnl_pct;
  const pnlUsd = wallet.pnl_usd;

  if (pnl == null) {
    // no PnL data
  } else if (pnl > 500) {
    parts.push(
      `Sitting on a ${fmt(pnl)}% gain \u2014 ${fmtUsd(Math.abs(pnlUsd))} in pure profit. Dominant.`
    );
  } else if (pnl > 50) {
    parts.push(
      `Up ${fmt(pnl)}% with ${fmtUsd(pnlUsd)} in gains. A strong showing.`
    );
  } else if (pnl > 5) {
    parts.push(`In the green at +${pnl.toFixed(1)}%. Steady.`);
  } else if (pnl > -5) {
    parts.push("Hovering right around breakeven.");
  } else if (pnl > -30) {
    parts.push(`Down ${Math.abs(pnl).toFixed(1)}% \u2014 still in the fight.`);
  } else {
    parts.push(
      `Taken a hit at ${pnl.toFixed(1)}%. Tough stretch but the competition isn't over.`
    );
  }

  // ── Special flags ──
  if ([35, 36].includes(wallet.id)) {
    parts.push(
      "Received BID minted directly from the null address \u2014 likely a team/insider wallet."
    );
  }

  if (airdrops.length > 0) {
    const totalClawlett = airdrops.reduce((s, a) => s + a.amount, 0);
    if (totalClawlett > 100000) {
      parts.push(
        `Also scooped up ${fmt(totalClawlett)} CLAWLETT from the ecosystem airdrop.`
      );
    }
  }

  if (withdrawals.length > 0) {
    const totalOut = withdrawals.reduce((s, w) => s + w.usd, 0);
    parts.push(`Has withdrawn ${fmtUsd(totalOut)} from the safe.`);
  }

  return { narrative: parts.join(" "), tradingStyle: style };
}

// ── Main Export ──

export function generateNarrative(walletData, txHistory, depositData) {
  const swapData = extractSwaps(txHistory || [], walletData.safe);
  const { narrative, tradingStyle } = buildNarrative(
    walletData,
    depositData,
    swapData
  );
  const keyMoments = extractKeyMoments(
    depositData.deposits || [],
    depositData.withdrawals || [],
    depositData.airdrops || [],
    swapData.swaps
  );

  return { narrative, keyMoments, tradingStyle };
}
