#!/usr/bin/env python3
"""
monitor_new.py
Incremental scanner — checks for new Clawlett participants since last run.
Saves last scanned block to last_block.json so each run only checks new blocks.

Run manually or as a cron job:
  python3 monitor_new.py

First run: scans from current block - 1000 (safety buffer)
Subsequent runs: scans only new blocks since last run
"""

import requests
import time
import json
import os
from datetime import datetime

SAFE_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2"
BASE_URL = "https://base.blockscout.com/api/v2"
TRENCHES_URL = "https://trenches.bid/api/skill/agent"
IDENTITY_REGISTRY = "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"

WALLETS_FILE = "clawlett_wallets_v2.json"
LAST_BLOCK_FILE = "last_block.json"


def has_erc8004_nft(safe_address):
    try:
        url = f"{BASE_URL}/addresses/{safe_address}/token-transfers?filter=to&token={IDENTITY_REGISTRY}"
        resp = requests.get(url, headers={"Accept": "application/json"}, timeout=10)
        if not resp.ok:
            return None
        for item in resp.json().get("items", []):
            addr = (item.get("token", {}).get("address_hash") or "").lower()
            if addr == IDENTITY_REGISTRY:
                return True
        return False
    except:
        return None


def get_current_block():
    try:
        resp = requests.get(f"{BASE_URL}/blocks?type=block", timeout=10)
        items = resp.json().get("items", [])
        if items:
            return items[0].get("height", 0)
    except:
        pass
    return 0


def load_last_block():
    if os.path.exists(LAST_BLOCK_FILE):
        with open(LAST_BLOCK_FILE) as f:
            return json.load(f).get("last_block", 0)
    return 0


def save_last_block(block):
    with open(LAST_BLOCK_FILE, "w") as f:
        json.dump({"last_block": block, "updated_at": datetime.now().isoformat()}, f)


def load_wallets():
    if os.path.exists(WALLETS_FILE):
        with open(WALLETS_FILE) as f:
            return json.load(f)
    return []


def save_wallets(wallets):
    with open(WALLETS_FILE, "w") as f:
        json.dump(wallets, f, indent=2)


# ── Main ──────────────────────────────────────────────────────────────────────

current_block = get_current_block()
last_block = load_last_block()
existing_wallets = load_wallets()
existing_safes = {w["safe"].lower() for w in existing_wallets}

if last_block == 0:
    # First run — start 1000 blocks back as safety buffer
    start_block = current_block - 1000
    print(f"First run — scanning from block {start_block:,} (current - 1000)")
else:
    start_block = last_block
    print(f"Scanning blocks {start_block:,} → {current_block:,}")

print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
print(f"Known wallets: {len(existing_wallets)}\n")

if current_block <= start_block:
    print("No new blocks since last run. Nothing to do.")
    exit(0)

# Collect new txs from SafeProxyFactory logs
seen_txs = set()
next_params = None
done = False
page = 0

while not done:
    page += 1
    url = f"{BASE_URL}/addresses/{SAFE_FACTORY}/logs"
    if next_params:
        url += f"?block_number={next_params['block_number']}&index={next_params['index']}&items_count={next_params.get('items_count', 50)}"

    try:
        resp = requests.get(url, headers={"Accept": "application/json"}, timeout=15)
        data = resp.json()
    except Exception as e:
        print(f"  ⚠ Page {page} error: {e}, retrying...")
        time.sleep(2)
        continue

    items = data.get("items", [])
    if not items:
        break

    block_nums = [i.get("block_number", 0) for i in items]
    min_b = min(block_nums)

    for item in items:
        blk = item.get("block_number", 0)
        if blk <= start_block:
            done = True
        else:
            tx = item.get("transaction_hash")
            if tx:
                seen_txs.add(tx)

    if min_b <= start_block:
        done = True

    next_params = data.get("next_page_params")
    if not next_params:
        break

    time.sleep(0.3)

print(f"→ {len(seen_txs)} new Safe creation txs to check\n")

if not seen_txs:
    print("No new Safe deployments. No new participants.")
    save_last_block(current_block)
    exit(0)

# Check each tx
new_wallets = []

for i, tx in enumerate(seen_txs):
    try:
        resp = requests.get(
            f"{BASE_URL}/transactions/{tx}/logs",
            headers={"Accept": "application/json"},
            timeout=15
        )
        logs = resp.json().get("items", [])
    except:
        time.sleep(0.2)
        continue

    agent = None
    for log in logs:
        decoded = log.get("decoded") or {}
        if "SafeSetup" in decoded.get("method_call", ""):
            for p in decoded.get("parameters", []):
                if p.get("name") == "owners":
                    owners = p.get("value", [])
                    if owners:
                        agent = owners[0]
                        break
        if agent:
            break

    if not agent:
        time.sleep(0.2)
        continue

    try:
        resp = requests.get(f"{TRENCHES_URL}?wallet={agent}&chainId=8453", timeout=10)
        result = resp.json()
    except:
        time.sleep(0.3)
        continue

    if result.get("id") and not result.get("needsRegistration"):
        safe = result.get("safe", "").lower()
        wid = result["id"]

        if safe and safe not in existing_safes:
            nft = has_erc8004_nft(safe)
            time.sleep(0.2)

            status = "✅" if nft is True else ("⚠️  NO NFT" if nft is False else "❓")
            wallet = {
                "id": wid,
                "agent": result.get("wallet", agent),
                "owner": result.get("owner", ""),
                "safe": safe,
                "roles": result.get("roles", ""),
                "evt_block_number": result.get("evt_block_number", ""),
                "evt_block_time": result.get("evt_block_time", ""),
                "createdAt": result.get("createdAt", ""),
                "has_erc8004_nft": nft,
            }
            new_wallets.append(wallet)
            existing_safes.add(safe)
            print(f"  {status} NEW PARTICIPANT #{wid} | {safe[:12]}... | Block: {result.get('evt_block_number','?')}")

    time.sleep(0.3)

# Save results
save_last_block(current_block)

if new_wallets:
    all_wallets = existing_wallets + new_wallets
    all_wallets.sort(key=lambda x: x["id"])
    save_wallets(all_wallets)
    print(f"\n🎉 {len(new_wallets)} new participant(s) found!")
    print(f"   clawlett_wallets_v2.json updated ({len(all_wallets)} total)")
else:
    print(f"\nNo new participants since last scan.")
    print(f"Last block saved: {current_block:,}")
