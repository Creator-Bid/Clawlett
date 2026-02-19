# Clawlett

<p align="center">
  <img src="assets/mascot.jpg" alt="Clawlett Mascot" width="400">
</p>

An [OpenClaw](https://openclaw.ai) skill for autonomous token swaps and Trenches trading on Base, powered by Gnosis Safe + Zodiac Roles.

## Overview

This skill enables AI agents to perform secure, permissioned token swaps and Trenches token creation/trading through a Gnosis Safe. The agent operates through Zodiac Roles module which restricts operations to:

- Swapping tokens via CoW Protocol (MEV-protected)
- Creating tokens on Trenches bonding curves
- Buying and selling tokens on Trenches bonding curves
- Approving tokens only for CoW Vault Relayer and AgentKeyFactoryV3
- All swapped tokens return to the Safe (no external transfers)

The human owner retains full control of the Safe while the agent can only execute swaps and trades.

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
│  • Call Aerodrome Router (swap functions)               │
│  • Call ApprovalHelper (approve for router)             │
│  • Send ETH (for ETH swaps)                             │
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
# JSON output
node clawlett/scripts/balance.js --json
### Swap Tokens

```bash
# Get quote
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.1

# Execute swap
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.1 --execute

# Swap by address (for tokens not in verified list)
node clawlett/scripts/swap.js --from USDC --to 0xa1832f7f4e534ae557f9b5ab76de54b1873e498b --amount 100 --execute
```

### Trenches Trading

Create tokens and trade on Trenches bonding curves:

```bash
# Create a new token
node clawlett/scripts/trenches.js create --name "My Token" --symbol MTK --description "A cool token"
node clawlett/scripts/trenches.js create --name "My Token" --symbol MTK --description "desc" --initial-buy 0.01

# Buy tokens with ETH
node clawlett/scripts/trenches.js buy --token MTK --amount 0.01

# Sell tokens for ETH
node clawlett/scripts/trenches.js sell --token MTK --amount 1000
node clawlett/scripts/trenches.js sell --token MTK --all

# Token info
node clawlett/scripts/trenches.js info MTK
```

### Token Discovery

Browse trending and top-performing tokens on Trenches:

```bash
node clawlett/scripts/trenches.js trending
node clawlett/scripts/trenches.js trending --window 1h --limit 5
node clawlett/scripts/trenches.js new
node clawlett/scripts/trenches.js top-volume
node clawlett/scripts/trenches.js gainers
node clawlett/scripts/trenches.js losers
```

### Custom RPC

All scripts support `--rpc` flag for custom RPC endpoints:

```bash
node clawlett/scripts/balance.js --rpc https://base.llamarpc.com
node clawlett/scripts/swap.js --from ETH --to USDC --amount 0.1 --rpc https://base.llamarpc.com
```

## Verified Tokens

Protected tokens can only resolve to verified addresses (scam protection):

| Token | Address |
|-------|---------|
| ETH/WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| USDT | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |
| DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |
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
| `QUOTE_API_URL` | Production API | Quote/routing API |
| `TRENCHES_API_URL` | `https://trenches.bid` | Trenches API endpoint |

## Contracts

| Contract | Address |
|----------|---------|
| Aerodrome Universal Router | `0x6Cb442acF35158D5eDa88fe602221b67B400Be3e` |
| ApprovalHelper | `0x55881791383A2ab8Fb6F98267419e83e074fd076` |
| Safe Singleton | `0x3E5c63644E683549055b9Be8653de26E0B4CD36E` |
| Safe Factory | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2` |
| Roles Singleton | `0x9646fDAD06d3e24444381f44362a3B0eB343D337` |
| Module Factory | `0x000000000000aDdB49795b0f9bA5BC298cDda236` |
| AgentKeyFactoryV3 | `0x2EA0010c18fa7239CAD047eb2596F8d8B7Cf2988` |

## OpenClaw Integration

This skill is designed to work with [OpenClaw](https://openclaw.ai) agents. The agent can:

- Check wallet balances on request
- Get swap quotes and explain trade details
- Execute swaps after user confirmation
- Create tokens on Trenches bonding curves
- Buy and sell tokens on Trenches bonding curves
- Discover trending, new, and top-performing tokens
- Protect users from scam tokens

See [SKILL.md](./clawlett/SKILL.md) for the skill specification.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT
