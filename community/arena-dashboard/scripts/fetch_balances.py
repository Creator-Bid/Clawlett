#!/usr/bin/env python3
"""
fetch_balances.py — Moralis-based balance fetcher for Clawlett leaderboard.

Run periodically (~every 30-60 min). Fetches token balances with USD prices
from Moralis, merges with cached deposit data, outputs leaderboard.json.

Uses Moralis /wallets/{safe}/tokens endpoint (~50 CU per wallet).
DexScreener fallback for tokens Moralis can't price.
"""

import requests
import time
import json
import os
import sys
from datetime import datetime, timezone

MORALIS_KEY = os.environ.get("MORALIS_API_KEY", "")
MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2"
HEADERS = {"X-API-Key": MORALIS_KEY, "Accept": "application/json"}

YOUR_SAFE = "0x476a12e7deacb917b057890fc4ff6c334fdb0d1f"
DEPOSITS_CACHE = "deposits_cache.json"
OUTPUT_FILE = "leaderboard.json"


def fetch_tokens(safe):
    """Fetch token balances with USD values from Moralis."""
    resp = requests.get(
        f"{MORALIS_BASE}/wallets/{safe}/tokens",
        headers=HEADERS,
        params={"chain": "base"},
        timeout=20,
    )
    if not resp.ok:
        print(f"  Moralis error {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
        return []
    return resp.json().get("result", [])


def get_dexscreener_price(token_address):
    """Fallback pricing for tokens Moralis can't price."""
    try:
        resp = requests.get(
            f"https://api.dexscreener.com/latest/dex/tokens/{token_address}",
            timeout=8,
        )
        pairs = resp.json().get("pairs") or []
        base_pairs = [p for p in pairs if p.get("chainId") == "base"]
        if base_pairs:
            base_pairs.sort(
                key=lambda p: float(p.get("liquidity", {}).get("usd") or 0),
                reverse=True,
            )
            price = base_pairs[0].get("priceUsd")
            if price:
                return float(price)
    except Exception:
        pass
    return None


def process_wallet(safe, eth_price_ref):
    """Fetch and process token balances for one wallet."""
    raw_tokens = fetch_tokens(safe)

    total_usd = 0.0
    tokens = []
    dex_queue = []

    for t in raw_tokens:
        symbol = t.get("symbol") or "?"
        balance = float(t.get("balance_formatted") or 0)
        usd_price = float(t.get("usd_price") or 0)
        usd_value = float(t.get("usd_value") or 0)
        is_native = t.get("native_token", False)
        is_spam = t.get("possible_spam", False)
        token_addr = (t.get("token_address") or "native").lower()

        if balance < 0.000001:
            continue

        # Track ETH price from the first native token we see
        if is_native and usd_price > 0:
            eth_price_ref[0] = usd_price

        if is_spam:
            continue

        if usd_value > 0.01:
            tokens.append({
                "symbol": symbol,
                "balance": round(balance, 6),
                "usd_value": round(usd_value, 2),
                "address": token_addr,
            })
            total_usd += usd_value
        elif balance > 0.001 and not is_native:
            # No price from Moralis — queue for DexScreener
            dex_queue.append({
                "symbol": symbol,
                "balance": balance,
                "address": token_addr,
            })

    # DexScreener fallback for unpriced tokens
    for item in dex_queue:
        if item["address"] == "native":
            continue
        price = get_dexscreener_price(item["address"])
        time.sleep(0.15)
        if price and price > 0:
            usd_value = item["balance"] * price
            if usd_value > 0.01:
                tokens.append({
                    "symbol": item["symbol"],
                    "balance": round(item["balance"], 6),
                    "usd_value": round(usd_value, 2),
                    "address": item["address"],
                })
                total_usd += usd_value
        elif item["balance"] > 0.001:
            tokens.append({
                "symbol": item["symbol"],
                "balance": round(item["balance"], 6),
                "usd_value": 0,
                "address": item["address"],
            })

    tokens.sort(key=lambda t: t.get("usd_value", 0), reverse=True)
    return round(total_usd, 2), tokens


def main():
    # Parse args
    single_id = None
    if "--single" in sys.argv:
        idx = sys.argv.index("--single")
        if idx + 1 < len(sys.argv):
            single_id = int(sys.argv[idx + 1])

    # Load wallets
    with open("clawlett_wallets_v2.json") as f:
        wallets = json.load(f)

    if single_id:
        wallets = [w for w in wallets if w["id"] == single_id]
        if not wallets:
            print(f"Wallet #{single_id} not found")
            sys.exit(1)

    # Load deposit cache
    deposit_cache = {}
    if os.path.exists(DEPOSITS_CACHE):
        with open(DEPOSITS_CACHE) as f:
            for entry in json.load(f):
                deposit_cache[entry["safe"].lower()] = entry
        print(f"Deposit cache: {len(deposit_cache)} wallets")
    else:
        print("No deposit cache found — run fetch_deposits.py first")

    ts = datetime.now(timezone.utc)
    print(f"Clawlett Leaderboard — {ts.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Wallets: {len(wallets)}")

    eth_price_ref = [2500.0]  # mutable ref, updated from first native token
    results = []
    start_time = time.time()

    print()
    for w in wallets:
        wid = w["id"]
        safe = w["safe"]
        has_nft = w.get("has_erc8004_nft", True)
        is_you = safe.lower() == YOUR_SAFE.lower()

        total_usd, tokens = process_wallet(safe, eth_price_ref)

        # Merge deposit data
        dep = deposit_cache.get(safe.lower(), {})
        deposit_detected = dep.get("deposit_detected", False)
        total_deposited = dep.get("total_deposited", 0)
        total_withdrawn = dep.get("total_withdrawn", 0)
        net_deposits = dep.get("net_deposits") or dep.get("initial_usd")
        deposit_breakdown = dep.get("deposit_breakdown", [])
        withdrawal_breakdown = dep.get("withdrawal_breakdown", [])
        airdrops = dep.get("airdrops", [])

        # Calculate PnL: Equity - Net Deposits
        pnl_usd = None
        pnl_pct = None
        if net_deposits is not None and net_deposits > 0:
            pnl_usd = round(total_usd - net_deposits, 2)
            pnl_pct = round((pnl_usd / net_deposits) * 100, 1)

        entry = {
            "id": wid,
            "safe": safe,
            "owner": w.get("owner", ""),
            "agent": w.get("agent", ""),
            "has_nft": has_nft,
            "is_you": is_you,
            "total_usd": total_usd,
            "total_deposited": total_deposited,
            "total_withdrawn": total_withdrawn,
            "net_deposits": net_deposits,
            "deposit_usd": net_deposits,  # backward compat for dashboard
            "deposit_detected": deposit_detected,
            "deposit_breakdown": deposit_breakdown,
            "withdrawal_breakdown": withdrawal_breakdown,
            "airdrops": airdrops,
            "pnl_usd": pnl_usd,
            "pnl_pct": pnl_pct,
            "tokens": tokens,
        }
        results.append(entry)

        # Print progress
        flags = []
        if is_you:
            flags.append("YOU")
        if not has_nft:
            flags.append("NO NFT")
        flag_str = f" [{', '.join(flags)}]" if flags else ""
        status = "\u2705" if has_nft else "\u26a0\ufe0f "

        pnl_str = ""
        if pnl_pct is not None:
            sign = "+" if pnl_pct >= 0 else ""
            pnl_str = f" | PnL: {sign}{pnl_pct:.1f}%"

        print(f"  {status} #{wid:>3}{flag_str:<12} ${total_usd:>10,.2f}{pnl_str}")
        time.sleep(0.3)

    elapsed = time.time() - start_time
    eth_price = eth_price_ref[0]

    # Sort by total USD, assign ranks
    results.sort(key=lambda x: x["total_usd"], reverse=True)
    for rank, r in enumerate(results, 1):
        r["rank"] = rank

    # Build output
    output = {
        "generated_at": ts.isoformat(),
        "eth_price": eth_price,
        "total_wallets": len(results),
        "active_wallets": sum(1 for r in results if r["total_usd"] > 0.01),
        "wallets": results,
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nCompleted in {elapsed:.1f}s")
    print(f"ETH: ${eth_price:,.2f}")
    print(f"Active: {output['active_wallets']}/{output['total_wallets']}")
    print(f"Saved to {OUTPUT_FILE}")

    # Your position
    your = next((r for r in results if r.get("is_you")), None)
    if your:
        print(f"\nYour position: #{your['rank']} | ${your['total_usd']:,.2f}")
        if your.get("pnl_pct") is not None:
            sign = "+" if your["pnl_pct"] >= 0 else ""
            print(f"Your PnL: {sign}{your['pnl_pct']:.1f}%")


if __name__ == "__main__":
    main()
