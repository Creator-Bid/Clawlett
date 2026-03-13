#!/bin/bash
# Clawlett Dashboard — Auto-refresh balances + copy to Vercel data
# Runs fetch_balances.py, copies fresh data, optionally redeploys
# Usage: ./refresh.sh [--deploy]

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD="$DIR/dashboard"
LOG="$DIR/refresh.log"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Starting refresh" >> "$LOG"

cd "$DIR"

# 1. Refresh balances (40 wallets × 100 CU = ~4,000 CU)
python3 fetch_balances.py >> "$LOG" 2>&1

# 2. Copy fresh data to dashboard
cp leaderboard.json wallet_history.json deposits_cache.json "$DASHBOARD/data/"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Data copied to dashboard/data/" >> "$LOG"

# 3. Redeploy to Vercel if --deploy flag is set
if [ "$1" = "--deploy" ]; then
  cd "$DASHBOARD"
  npx vercel --prod --yes >> "$LOG" 2>&1
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Deployed to Vercel" >> "$LOG"
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') — Refresh complete" >> "$LOG"
echo "---" >> "$LOG"
