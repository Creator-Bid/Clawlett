import fs from "fs";
import path from "path";
import { generateNarrative } from "../../../lib/narrativeEngine";

// Cache wallet_history.json in memory (2.6MB, rarely changes)
let cachedHistory = null;
let cachedHistoryMtime = 0;

function resolveDataFile(filename) {
  const candidates = [
    path.join(process.cwd(), "data", filename),
    path.join(process.cwd(), "..", filename),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getHistory(histPath) {
  try {
    const stat = fs.statSync(histPath);
    if (!cachedHistory || stat.mtimeMs !== cachedHistoryMtime) {
      cachedHistory = JSON.parse(fs.readFileSync(histPath, "utf-8"));
      cachedHistoryMtime = stat.mtimeMs;
    }
  } catch {
    cachedHistory = {};
  }
  return cachedHistory;
}

export default function handler(req, res) {
  const { id } = req.query;
  const walletId = parseInt(id, 10);

  if (isNaN(walletId)) {
    return res.status(400).json({ error: "Invalid wallet ID" });
  }

  const lbPath = resolveDataFile("leaderboard.json");
  const histPath = resolveDataFile("wallet_history.json");
  const depPath = resolveDataFile("deposits_cache.json");

  if (!lbPath) {
    return res.status(500).json({ error: "leaderboard.json not found" });
  }

  try {
    // Read leaderboard
    const lb = JSON.parse(fs.readFileSync(lbPath, "utf-8"));
    const walletData = lb.wallets.find((w) => w.id === walletId);
    if (!walletData) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    // Read history (cached)
    const allHistory = histPath ? getHistory(histPath) : {};
    const txHistory = allHistory[walletData.safe.toLowerCase()] || allHistory[walletData.safe] || [];

    // Read deposits
    let depositData = {};
    if (depPath) {
      const allDeposits = JSON.parse(fs.readFileSync(depPath, "utf-8"));
      depositData = allDeposits.find((d) => d.id === walletId) || {};
    }

    // Generate
    const result = generateNarrative(walletData, txHistory, depositData);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json({ walletId, ...result });
  } catch (err) {
    console.error("Narrative error:", err);
    res.status(500).json({ error: err.message });
  }
}
