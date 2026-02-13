# Trading Strategies

This directory contains example trading strategies and a framework for building your own.

## Overview

Clawlett provides the building blocks for autonomous token trading via Safe + Zodiac Roles.
You can build custom strategies on top of the core scripts (`balance.js`, `swap.js`).

## Strategy Framework

A strategy typically follows this pattern:

```javascript
const { execSync } = require('child_process');

// 1. Check current balances
function getBalances() {
  const output = execSync('node balance.js --all', { encoding: 'utf8' });
  // Parse balances from output
  return { ETH: 0.1, USDC: 100 };
}

// 2. Make trading decision
function decide(balances, marketData) {
  // Your logic here
  return { action: 'buy', from: 'USDC', to: 'ETH', amount: 50 };
}

// 3. Execute trade
function executeTrade(decision) {
  if (decision.action === 'hold') return;

  const cmd = `node swap.js --from ${decision.from} --to ${decision.to} --amount ${decision.amount} --execute`;
  execSync(cmd);
}

// 4. Run loop
function run() {
  const balances = getBalances();
  const decision = decide(balances, {});
  executeTrade(decision);
}
```

## Example Strategies

### Dollar-Cost Averaging (DCA)

Buy a fixed amount at regular intervals regardless of price:

```javascript
// Buy $10 worth of ETH every hour
const DCA_AMOUNT = 10; // USDC
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  execSync(`node swap.js --from USDC --to ETH --amount ${DCA_AMOUNT} --execute`);
}, INTERVAL_MS);
```

### Rebalancing

Maintain a target portfolio allocation:

```javascript
const TARGET = { ETH: 0.6, USDC: 0.4 }; // 60% ETH, 40% USDC

function rebalance() {
  const balances = getBalances();
  const total = balances.ETH * ethPrice + balances.USDC;

  const currentEthRatio = (balances.ETH * ethPrice) / total;

  if (currentEthRatio > TARGET.ETH + 0.05) {
    // Sell ETH, too much
  } else if (currentEthRatio < TARGET.ETH - 0.05) {
    // Buy ETH, too little
  }
}
```

### Grid Trading

Place orders at fixed price intervals:

```javascript
const GRID_SIZE = 0.02; // 2% between levels
const AMOUNT_PER_GRID = 20; // USDC per grid level

// Buy when price drops, sell when price rises
function checkGrid(currentPrice, lastPrice) {
  const priceChange = (currentPrice - lastPrice) / lastPrice;

  if (priceChange < -GRID_SIZE) {
    // Price dropped, buy
    execSync(`node swap.js --from USDC --to ETH --amount ${AMOUNT_PER_GRID} --execute`);
  } else if (priceChange > GRID_SIZE) {
    // Price rose, sell
    // Calculate ETH amount to sell
  }
}
```

## Using Trade History

Track your trades with the history module:

```javascript
import { logTrade, getHistory, getPnL } from './history.js';

// Log after each trade
logTrade({
  from: 'USDC',
  to: 'ETH', 
  amountIn: '100',
  amountOut: '0.05',
  txHash: '0x...'
});

// Check performance
const pnl = getPnL();
console.log(`Total trades: ${pnl.totalTrades}`);
console.log(`Net changes:`, pnl.netChanges);
```

## Running Strategies

### Manual
```bash
node strategies/my_strategy.cjs
```

### Background (survives SSH disconnect)
```bash
nohup node strategies/my_strategy.cjs > strategy.log 2>&1 &
```

### With PM2 (auto-restart on crash)
```bash
npm install -g pm2
pm2 start strategies/my_strategy.cjs --name my-strategy
pm2 save
pm2 startup  # Auto-start on reboot
```

### As Systemd Service
```ini
# /etc/systemd/system/clawlett-strategy.service
[Unit]
Description=Clawlett Trading Strategy
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/clawlett/scripts
ExecStart=/usr/bin/node strategies/my_strategy.cjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Best Practices

1. **Start Small** - Test with small amounts first
2. **Log Everything** - Use the history module to track trades
3. **Handle Errors** - CoW orders can take time, handle timeouts
4. **Monitor** - Check logs regularly, set up alerts
5. **Secure Keys** - Never commit private keys or secrets

## Tips for CoW Protocol

- Orders may take 30-120 seconds to fill (batch auctions)
- Use longer timeouts for larger orders
- MEV protection is automatic
- Check order status at https://explorer.cow.fi/base/orders/{orderUid}

## Contributing

Have a strategy to share? PRs welcome! Just don't include any secrets or API keys.
