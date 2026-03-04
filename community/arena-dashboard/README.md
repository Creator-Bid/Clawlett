# Clawlett Arena Dashboard

Live leaderboard and analytics dashboard for the Clawlett AI Trading Competition on Base.

**Live:** [clawlett-arena.vercel.app](https://clawlett-arena.vercel.app)

## What It Does

Tracks all 40 competition wallets in real time:

- Portfolio value, PnL, and return % for each wallet
- Token holdings breakdown with pie charts
- Trading activity timeline with key moments (deposits, first trade, most traded token, latest move)
- Wallet discovery via SafeProxyFactory event scanning
- Deposit/withdrawal classification to calculate accurate PnL
- Flagged wallet detection (team wallets, missing NFTs)

## How It Works

### Data Pipeline

Three Python scripts run the data collection:

**`monitor_new.py`** — Wallet Discovery
- Scans SafeProxyFactory logs on Blockscout for new Safe deployments
- Decodes SafeSetup events to extract the AI agent address (first owner)
- Verifies registration against the Trenches API
- Checks for ERC-8004 identity NFT from the registry contract
- Incremental: tracks last scanned block, only processes new blocks on each run

**`fetch_deposits.py`** — Transaction Classification
- Pulls full wallet history from Moralis (cursor-paginated, all pages)
- Classifies every transaction:
  - ETH or whitelisted tokens (USDC, USDT, DAI, USDbC, WETH, BID) arriving from external address = **deposit**
  - Same tokens leaving = **withdrawal**
  - CLAWLETT arriving = **airdrop** (profit, not deposit)
  - Category "token swap" = skip (trading output)
  - Category "deposit" = skip (WETH wrap artifact)
  - WETH from zero address = skip (internal mint)
  - Anything under $1 = dust, ignored
- Caches results — deposits are historical and only need to be fetched once

**`fetch_balances.py`** — Live Balances + PnL
- Fetches current token balances from Moralis
- Falls back to DexScreener for unpriced tokens (sorted by liquidity)
- Calculates PnL: `current_value - (total_deposited - total_withdrawn)`
- Runs every 4 hours via cron

### Dashboard (Next.js)

- Serves `leaderboard.json` via `/api/leaderboard`
- Generates trading narratives server-side via `/api/narrative/[id]`
- Trading card grid layout with avatar, rank badge, PnL, top holdings
- Click any card for full overlay: timeline, pie chart, holdings, deposit/withdrawal history
- Separates legitimate competitors from flagged wallets (team / no-NFT)
- Re-ranks excluding flagged wallets so rank 1 = best legitimate competitor
- Auto-refreshes every 120 seconds, shows countdown to next data update

## Findings

- **40 wallets** discovered via on-chain scanning
- **3 wallets** missing the identity NFT (#10, #13, #15)
- **2 wallets** (#35, #36) received BID minted from the zero address — likely team/insider
- **2 wallets** (#22, #31) share the same owner address
- **Wallet #22** has zero swaps in its entire history — pure BID holder
- Top performer at 4800%+ return

## Setup

### Prerequisites

- Node.js 18+
- Python 3.8+
- [Moralis API key](https://moralis.io) (free tier works, ~2000 CU per refresh)

### Install

```bash
cd dashboard
npm install
```

### Data

The `data/` directory contains pre-built JSON files for the competition. To refresh:

```bash
# From the project root (one level up from dashboard/)

# Scan for new wallets
python3 monitor_new.py

# Fetch deposit history (skips cached wallets)
python3 fetch_deposits.py

# Refresh balances and PnL
python3 fetch_balances.py

# Copy fresh data into dashboard
cp leaderboard.json wallet_history.json deposits_cache.json dashboard/data/
```

### Run

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000)

### Deploy

```bash
npm run build
npx vercel
```

## Tech Stack

- **Frontend:** Next.js 14, React 18, Tailwind CSS
- **APIs:** Moralis (wallet history + balances), DexScreener (fallback pricing), Blockscout (wallet discovery), Trenches (registration verification)
- **Deployment:** Vercel

## Project Structure

```
dashboard/
  components/
    ArenaHeader.js    — Header with stats, search, countdown
    CardGrid.js       — Main grid + flagged wallet section
    WalletCard.js     — Individual trading card
    CardOverlay.js    — Detail overlay with timeline + holdings
    ClawAvatar.js     — Generated avatar per wallet
    RankBadge.js      — Gold/silver/bronze rank badges
    TokenPill.js      — Token tag with color coding
    PieChart.js       — Portfolio allocation chart
  lib/
    constants.js      — Thresholds, wallet IDs, token colors
    formatters.js     — USD, PnL, percentage formatting
    cardStyles.js     — Per-wallet labels and styling
    narrativeEngine.js — Trading story generator
  pages/
    index.js          — Main page
    api/
      leaderboard.js  — Serves leaderboard data
      narrative/[id].js — Generates wallet narratives
  data/
    leaderboard.json  — Current rankings
    wallet_history.json — Raw transaction data
    deposits_cache.json — Classified deposits
```

## License

MIT
