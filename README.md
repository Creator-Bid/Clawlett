# Clawlett

<p align="center">
  <img src="assets/mascot.jpg" alt="Clawlett Mascot" width="400">
</p>

An [OpenClaw](https://openclaw.ai) skill for autonomous token swaps on Base via CoW Protocol, powered by Gnosis Safe + Zodiac Roles.

## Overview

This skill enables AI agents to perform secure, permissioned token swaps through a Gnosis Safe. The agent operates through Zodiac Roles module which restricts operations to:

- Swapping tokens via CoW Protocol (MEV-protected batch auctions)
- Approving tokens for the CoW Vault Relayer
- Presigning CoW orders via ZodiacHelpers delegatecall
- Wrapping/unwrapping ETH via ZodiacHelpers
- All swapped tokens return to the Safe (no external transfers)

The human owner retains full control of the Safe while the agent can only execute swaps.

## Security Model

```
┌─────────────────────────────────────────────────────────┐
│                     Gnosis Safe                         │
│                  (holds all funds)                      │
│                                                         │
│  Owner: Human Wallet (full control)                     │
│  Module: Zodiac Roles (restricted agent access)         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Zodiac Roles                          │
│                                                         │
│  Agent can ONLY:                                        │
│  • Presign CoW Protocol orders (MEV-protected swaps)    │
│  • Wrap/unwrap ETH via ZodiacHelpers                    │
│  • Approve tokens for CoW Vault Relayer                 │
│                                                         │
│  Agent CANNOT:                                          │
│  • Transfer tokens out of Safe                          │
│  • Change Safe settings                                 │
│  • Add/remove owners                                    │
└─────────────────────────────────────────────────────────┘
```

## Installation

```bash
cd clawlett/scripts
npm install
```

## Setup

1. Initialize the wallet (deploys Safe + Roles):

```bash
node clawlett/scripts/initialize.js --owner <YOUR_WALLET_ADDRESS>
```

2. Fund the agent address with ~0.001 ETH for gas (address shown in output)

3. Run the script again - it will complete the setup automatically

4. Fund your Safe with tokens to trade

## Usage

### Check Balances

```bash
# ETH balance
node clawlett/scripts/balance.js

# Specific token
node clawlett/scripts/balance.js --token USDC

# All verified tokens
node clawlett/scripts/balance.js --all
```

### Swap Tokens

Swaps use CoW Protocol for MEV-protected execution. ETH is auto-wrapped to WETH (CoW requires ERC20s).

```bash
# Get quote
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.1

# Execute swap (presigns CoW order, then polls until filled)
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.1 --execute

# Agent-friendly JSON output
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.1 --json

# Custom order timeout (default: 1800s = 30min)
node clawlett/scripts/swap.js --from USDC --to ETH --amount 100 --execute --timeout 600

# Swap by address (for tokens not in verified list)
node clawlett/scripts/swap.js --from USDC --to 0xa1832f7f4e534ae557f9b5ab76de54b1873e498b --amount 100 --execute
```

### Risk Guardrails

Swap includes built-in safety checks for autonomous agents:

```bash
# Cap each trade to max 10% of balance
node clawlett/scripts/swap.js --from ETH --to USDC --amount 5 --max-balance-usage-pct 10 --execute

# Keep at least 0.01 ETH in Safe for gas
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.5 --min-safe-eth-reserve 0.01 --execute
```

Defaults (configurable via env or CLI):
- `MAX_BALANCE_USAGE_PCT=25` — reject trades using more than 25% of balance
- `MIN_SAFE_ETH_RESERVE=0.001` — keep at least 0.001 ETH for gas

### Trade History & PnL

Every executed swap is automatically logged to `config/trade-history.json` with CoW order UIDs.

```bash
# View PnL summary
node clawlett/scripts/trade-history.js

# Machine-readable output
node clawlett/scripts/trade-history.js --json

# Export to CSV (includes CoW explorer links)
node clawlett/scripts/trade-history.js --export trades.csv

# Reset history
node clawlett/scripts/trade-history.js --reset
```

### Autonomous Strategies

Run pre-built trading strategies. All strategies use CoW Protocol and handle the async order lifecycle (presign, batch, fill) automatically.

```bash
# DCA: buy $10 of ETH with USDC every hour
node clawlett/scripts/strategy.js --strategy dca --from USDC --to ETH --amount 10 --interval 3600

# DCA with limit: 5 rounds only
node clawlett/scripts/strategy.js --strategy dca --from USDC --to AERO --amount 5 --interval 1800 --max-rounds 5

# Limit order: sell 0.1 ETH when output >= 280 USDC
node clawlett/scripts/strategy.js --strategy limit --from ETH --to USDC --amount 0.1 --min-out 280

# Rebalance: maintain 60/40 ETH/USDC allocation
node clawlett/scripts/strategy.js --strategy rebalance --tokens ETH,USDC --target 60,40 --threshold 5

# Dry run any strategy (no execution)
node clawlett/scripts/strategy.js --dry-run --strategy dca --from USDC --to ETH --amount 10
```

Available strategies:
| Strategy | Description |
|----------|-------------|
| `dca` | Dollar-cost average into a token at fixed intervals |
| `rebalance` | Maintain target allocation between two tokens (reads balances, computes drift, swaps to rebalance) |
| `limit` | Wait for price target, then execute single swap |

### Custom RPC

All scripts support `--rpc` flag for custom RPC endpoints:

```bash
node clawlett/scripts/balance.js --rpc https://base.llamarpc.com
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.1 --rpc https://base.llamarpc.com
```

## Verified Tokens

Protected tokens can only resolve to verified addresses (scam protection). Unverified tokens are searched via DexScreener with warnings.

| Token | Address |
|-------|---------|
| ETH/WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |
| DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` |
| USDS | `0x820C137fa70C8691f0e44Dc420a5e53c168921Dc` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |
| VIRTUAL | `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` |
| BID | `0xa1832f7f4e534ae557f9b5ab76de54b1873e498b` |

## Configuration

Config is stored in `config/wallet.json` after initialization:

```json
{
  "chainId": 8453,
  "owner": "0x...",
  "agent": "0x...",
  "safe": "0x...",
  "roles": "0x...",
  "roleKey": "0x..."
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `WALLET_CONFIG_DIR` | `./config` | Config directory |
| `MAX_BALANCE_USAGE_PCT` | `25` | Max % of token balance per trade |
| `MIN_SAFE_ETH_RESERVE` | `0.001` | Min ETH to keep in Safe for gas |
| `TRADE_HISTORY_PATH` | `config/trade-history.json` | Trade log file path |

## Contracts

| Contract | Address |
|----------|---------|
| CoW Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` |
| CoW Vault Relayer | `0xC92E8bdf79f0507f65a392b0ab4667716BFE0110` |
| ZodiacHelpers | See `config/wallet.json` (deployed per-agent) |
| Safe Singleton | `0x3E5c63644E683549055b9Be8653de26E0B4CD36E` |
| Safe Factory | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` |
| Roles Singleton | `0x9646fDAD06d3e24444381f44362a3B0eB343D337` |
| Module Factory | `0x000000000000aDdB49795b0f9bA5BC298cDda236` |

## OpenClaw Integration

This skill is designed to work with [OpenClaw](https://openclaw.ai) agents. The agent can:

- Check wallet balances on request
- Get swap quotes and explain trade details
- Execute MEV-protected swaps via CoW Protocol
- Protect users from scam tokens
- Run autonomous strategies (DCA, limit orders, rebalancing)
- Track PnL across all trades with CoW explorer links

See [SKILL.md](./clawlett/SKILL.md) for the skill specification.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT
