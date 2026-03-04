#!/usr/bin/env python3
"""
fetch_deposits.py — Moralis-based deposit detection for Clawlett wallets.

Run ONCE to populate deposits_cache.json. Use --force to re-fetch all.
Also saves raw tx history to wallet_history.json for data analysis.

Detection logic:
  - Deposits = ETH + USDC/stables + BID receives (real user funding, any timing)
  - Airdrops = CLAWLETT receives (tracked separately, counts as profit not deposit)
  - Skip: WETH wraps from 0x0000, swap outputs (category "token swap"), dust < $1
  - PnL = current_value - total_invested (where total_invested = deposits only)
"""

import requests
import time
import json
import os
import sys

MORALIS_KEY = os.environ.get("MORALIS_API_KEY", "")
MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2"
HEADERS = {"X-API-Key": MORALIS_KEY, "Accept": "application/json"}
COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price"
COINGECKO_KEY = os.environ.get("COINGECKO_API_KEY", "")

STABLES = {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",  # USDC
    "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",  # USDT
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb",  # DAI
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",  # USDbC
}

WETH = "0x4200000000000000000000000000000000000006"
BID = "0xa1832f7f4e534ae557f9b5ab76de54b1873e498b"
CLAWLETT = "0xc34803d003f582b122b9575c14007373ad8c9383"

# Deposit whitelist: only these tokens count as user funding
# ETH (native) + stables + WETH (real transfers, not wraps) + BID
DEPOSIT_TOKENS = STABLES | {WETH, BID}

# CoinGecko IDs for pricing (used for balance fetching + BID deposit pricing)
COINGECKO_IDS = {
    "0x940181a94a35a4569e4529a3cdfb74e38fd98631": ("AERO", "aerodrome-finance"),
    "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": ("VIRTUAL", "virtual-protocol"),
    "0x4ed4e862860bed51a9570b96d89af5e1b0efefed": ("DEGEN", "degen-base"),
    "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4": ("TOSHI", "toshi"),
    "0x532f27101965dd16442e59d40670faf5ebb142e4": ("BRETT", "brett"),
    BID: ("BID", "creatorbid"),
    "0x768be13e1680b5ebe0024c42c896e3db59ec0149": ("SKI", "ski-mask-dog"),
    "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": ("cbBTC", "coinbase-wrapped-btc"),
    "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": ("cbETH", "coinbase-wrapped-staked-eth"),
}

CACHE_FILE = "deposits_cache.json"
HISTORY_FILE = "wallet_history.json"


def get_prices():
    """Fetch ETH price + all known token prices from CoinGecko."""
    cg_ids = ["ethereum"] + [v[1] for v in COINGECKO_IDS.values()]
    ids_str = ",".join(set(cg_ids))
    prices = {}
    try:
        resp = requests.get(
            COINGECKO_URL,
            params={"ids": ids_str, "vs_currencies": "usd"},
            headers={"x_cg_demo_api_key": COINGECKO_KEY},
            timeout=10,
        )
        data = resp.json()
        prices["ETH"] = data.get("ethereum", {}).get("usd", 2500)
        prices["WETH"] = prices["ETH"]
        for addr, (symbol, cg_id) in COINGECKO_IDS.items():
            if cg_id in data and "usd" in data[cg_id]:
                prices[addr] = data[cg_id]["usd"]
    except Exception as e:
        print(f"  CoinGecko error: {e}", file=sys.stderr)
        prices.setdefault("ETH", 2500)
        prices.setdefault("WETH", 2500)
    return prices


def fetch_all_history(safe):
    """Fetch complete wallet history from Moralis, ASC order, all pages."""
    all_txs = []
    cursor = None
    while True:
        params = {"chain": "base", "order": "ASC", "limit": 100}
        if cursor:
            params["cursor"] = cursor
        resp = requests.get(
            f"{MORALIS_BASE}/wallets/{safe}/history",
            headers=HEADERS,
            params=params,
            timeout=20,
        )
        if not resp.ok:
            print(f"  Moralis error {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
            break
        data = resp.json()
        txs = data.get("result", [])
        all_txs.extend(txs)
        cursor = data.get("cursor")
        if not cursor or not txs:
            break
        time.sleep(0.2)
    return all_txs


def price_token(token_addr, prices):
    """Get USD price for a deposit-whitelist token."""
    eth_price = prices.get("ETH", 2500)
    if token_addr in STABLES:
        return 1.0
    elif token_addr == WETH:
        return eth_price
    elif token_addr in prices:
        return prices[token_addr]
    return 0


def detect_deposits(safe, owner, all_txs, prices):
    """
    Detect deposits and withdrawals for PnL calculation.

    Deposits (user funding in):
      - Native ETH receives to safe > $1 (not from safe itself)
      - ERC20 receives of DEPOSIT_TOKENS (USDC/stables, WETH, BID) > $1
      - Skip: WETH mints from 0x0000 (wrap artifacts)
      - Skip: anything in "token swap" category (those are swap outputs)
      - Skip: anything in "deposit" category (WETH wraps)

    Withdrawals (user pulling money out):
      - Native ETH sends FROM safe > $1 (not in swap/deposit categories)
      - ERC20 sends of DEPOSIT_TOKENS FROM safe > $1 (not in swap categories)

    Airdrops (tracked separately, count as profit):
      - CLAWLETT receives
      - Everything else not in DEPOSIT_TOKENS

    Net Deposits = total_deposited - total_withdrawn
    PnL = current_value - net_deposits
    """
    safe_l = safe.lower()
    eth_price = prices.get("ETH", 2500)

    # Find first swap block
    first_swap_block = None
    for tx in all_txs:
        cat = (tx.get("category") or "").lower()
        if cat == "token swap":
            first_swap_block = int(tx.get("block_number") or 0)
            break

    deposits = []
    withdrawals = []
    airdrops = []

    for tx in all_txs:
        block = int(tx.get("block_number") or 0)
        cat = (tx.get("category") or "").lower()
        ts = tx.get("block_timestamp")

        # Skip swap txs — tokens moving in swaps are trading, not deposits/withdrawals
        if cat == "token swap":
            continue

        # Skip WETH wrap txs (safe converting its own ETH to WETH)
        if cat == "deposit":
            continue

        # === Native ETH ===
        for nt in tx.get("native_transfers", []):
            from_addr = (nt.get("from_address") or "").lower()
            to_addr = (nt.get("to_address") or "").lower()
            val = float(nt.get("value_formatted") or nt.get("value", "0"))
            # Moralis sometimes gives value in wei as string without value_formatted
            if val > 1e15:
                val = val / 1e18
            usd = val * eth_price

            if usd < 1.0:
                continue

            if to_addr == safe_l and from_addr != safe_l:
                deposits.append({
                    "type": "ETH", "amount": val, "usd": round(usd, 2),
                    "from": from_addr, "block": block, "timestamp": ts,
                })
            elif from_addr == safe_l and to_addr != safe_l:
                withdrawals.append({
                    "type": "ETH", "amount": val, "usd": round(usd, 2),
                    "to": to_addr, "block": block, "timestamp": ts,
                })

        # === ERC-20 ===
        for et in tx.get("erc20_transfers", []):
            from_addr = (et.get("from_address") or "").lower()
            to_addr = (et.get("to_address") or "").lower()
            token_addr = (et.get("address") or "").lower()
            amount = float(et.get("value_formatted") or 0)

            if amount < 0.0001:
                continue

            # --- Incoming to safe ---
            if to_addr == safe_l and from_addr != safe_l:
                # Skip WETH mints from 0x0000 (wrap artifacts)
                if token_addr == WETH and from_addr.startswith("0x000000000000"):
                    continue

                # Is this a deposit-whitelist token?
                if token_addr in DEPOSIT_TOKENS:
                    p = price_token(token_addr, prices)
                    usd = amount * p
                    if usd >= 1.0:
                        deposits.append({
                            "type": "USDC" if token_addr in STABLES else
                                   "WETH" if token_addr == WETH else "BID",
                            "token_address": token_addr,
                            "amount": amount, "usd": round(usd, 2),
                            "from": from_addr, "block": block, "timestamp": ts,
                        })
                # Track CLAWLETT as airdrop
                elif token_addr == CLAWLETT:
                    p = prices.get(token_addr, 0)
                    airdrops.append({
                        "type": "CLAWLETT", "token_address": token_addr,
                        "amount": amount, "usd": round(amount * p, 2) if p else 0,
                        "from": from_addr, "block": block, "timestamp": ts,
                    })
                # Everything else: ignored (airdrop dust)

            # --- Outgoing from safe (withdrawal) ---
            elif from_addr == safe_l and to_addr != safe_l:
                if token_addr in DEPOSIT_TOKENS:
                    p = price_token(token_addr, prices)
                    usd = amount * p
                    if usd >= 1.0:
                        withdrawals.append({
                            "type": "USDC" if token_addr in STABLES else
                                   "WETH" if token_addr == WETH else "BID",
                            "token_address": token_addr,
                            "amount": amount, "usd": round(usd, 2),
                            "to": to_addr, "block": block, "timestamp": ts,
                        })

    total_deposited = sum(d["usd"] for d in deposits)
    total_withdrawn = sum(w["usd"] for w in withdrawals)
    net_deposits = total_deposited - total_withdrawn

    deposit_breakdown = [
        f"{d['type']}: {d['amount']:.6f} (${d['usd']:.2f})" for d in deposits
    ]
    withdrawal_breakdown = [
        f"{w['type']}: {w['amount']:.6f} (${w['usd']:.2f})" for w in withdrawals
    ]

    return {
        "safe": safe,
        "owner": owner,
        "deposit_detected": len(deposits) > 0,
        "total_deposited": round(total_deposited, 2),
        "total_withdrawn": round(total_withdrawn, 2),
        "net_deposits": round(net_deposits, 2),
        "initial_usd": round(net_deposits, 2),  # backward compat for fetch_balances
        "deposits": deposits,
        "withdrawals": withdrawals,
        "airdrops": airdrops,
        "deposit_breakdown": deposit_breakdown,
        "withdrawal_breakdown": withdrawal_breakdown,
        "first_swap_block": first_swap_block,
    }


def main():
    force = "--force" in sys.argv

    with open("clawlett_wallets_v2.json") as f:
        wallets = json.load(f)

    cache = {}
    if not force and os.path.exists(CACHE_FILE):
        with open(CACHE_FILE) as f:
            data = json.load(f)
            for entry in data:
                cache[entry["safe"].lower()] = entry

    history = {}
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE) as f:
            history = json.load(f)

    print(f"Clawlett Deposit Detection (Moralis)")
    print(f"Wallets: {len(wallets)} | Cached: {len(cache)} | Force: {force}")
    print()

    print("Fetching prices...")
    prices = get_prices()
    eth_price = prices.get("ETH", 2500)
    print(f"  ETH: ${eth_price:,.2f}")
    print(f"  Token prices: {len(prices) - 2} loaded")
    print("=" * 60)

    new_count = 0
    for w in wallets:
        wid = w["id"]
        safe = w["safe"]
        owner = w["owner"]

        if safe.lower() in cache and not force:
            print(f"  #{wid:>3} | cached")
            continue

        print(f"  #{wid:>3} | {safe[:14]}... fetching history...")

        all_txs = fetch_all_history(safe)
        time.sleep(0.1)

        history[safe.lower()] = all_txs

        result = detect_deposits(safe, owner, all_txs, prices)
        result["id"] = wid
        result["tx_count"] = len(all_txs)
        cache[safe.lower()] = result
        new_count += 1

        if result["deposit_detected"]:
            print(f"         Deposited: ${result['total_deposited']:,.2f} ({len(result['deposits'])} transfers)")
            for d in result["deposit_breakdown"]:
                print(f"           + {d}")
            if result["withdrawals"]:
                print(f"         Withdrawn: ${result['total_withdrawn']:,.2f} ({len(result['withdrawals'])} transfers)")
                for w in result["withdrawal_breakdown"]:
                    print(f"           - {w}")
            print(f"         Net deposits: ${result['net_deposits']:,.2f}")
            if result["airdrops"]:
                airdrop_total = sum(a["usd"] for a in result["airdrops"])
                print(f"         Airdrops: {len(result['airdrops'])} (${airdrop_total:,.2f})")
        else:
            print(f"         No deposits detected ({len(all_txs)} txs)")

        time.sleep(0.3)

    cache_list = sorted(cache.values(), key=lambda x: x.get("id", 0))
    with open(CACHE_FILE, "w") as f:
        json.dump(cache_list, f, indent=2)

    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)

    print()
    print("=" * 60)
    detected = sum(1 for c in cache.values() if c.get("deposit_detected"))
    print(f"Deposits detected: {detected}/{len(cache)}")
    print(f"New fetches: {new_count}")
    print(f"Saved to {CACHE_FILE}")
    print(f"History saved to {HISTORY_FILE} ({len(history)} wallets)")


if __name__ == "__main__":
    main()
