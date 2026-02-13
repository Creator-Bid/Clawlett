#!/usr/bin/env node

/**
 * Trade history logger and PnL tracker for Clawlett
 *
 * Logs every CoW Protocol swap to a local JSON file and calculates realized PnL.
 * Designed for autonomous agents competing in trading challenges.
 *
 * Usage:
 *   node trade-history.js                    # Show trade log + PnL summary
 *   node trade-history.js --json             # Machine-readable output
 *   node trade-history.js --reset            # Clear trade history
 *   node trade-history.js --export trades.csv # Export to CSV
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_HISTORY_PATH = path.join(__dirname, '..', 'config', 'trade-history.json')

const COW_EXPLORER_BASE = 'https://explorer.cow.fi/base/orders'

// Stablecoin addresses on Base (used to determine USD value)
const STABLECOINS = {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USDT',
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
    '0x820c137fa70c8691f0e44dc420a5e53c168921dc': 'USDS',
}

function loadHistory(historyPath) {
    if (!fs.existsSync(historyPath)) return { trades: [], startedAt: new Date().toISOString() }
    return JSON.parse(fs.readFileSync(historyPath, 'utf8'))
}

function saveHistory(history, historyPath) {
    const dir = path.dirname(historyPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2))
}

/**
 * Record a trade (called by swap.js after successful execution)
 */
export function recordTrade(trade, historyPath = DEFAULT_HISTORY_PATH) {
    const history = loadHistory(historyPath)
    history.trades.push({
        id: history.trades.length + 1,
        timestamp: new Date().toISOString(),
        orderUid: trade.orderUid,
        tokenIn: trade.tokenIn,
        tokenOut: trade.tokenOut,
        amountIn: trade.amountIn,
        amountOut: trade.amountOut,
        decimalsIn: trade.decimalsIn,
        decimalsOut: trade.decimalsOut,
    })
    saveHistory(history, historyPath)
    return history.trades.length
}

/**
 * Calculate PnL from trade history
 *
 * Strategy: tracks net position per token relative to stablecoins.
 * - Selling TOKEN for STABLE = realized at that price
 * - Buying TOKEN with STABLE = cost basis entry
 * - TOKEN-to-TOKEN swaps recorded but PnL deferred
 */
function calculatePnL(trades) {
    let totalStableIn = 0   // stablecoins spent buying tokens
    let totalStableOut = 0  // stablecoins received selling tokens

    const positions = {}    // { symbol: { bought, sold, spent, received } }

    for (const t of trades) {
        const inIsStable = isStablecoin(t.tokenIn?.address)
        const outIsStable = isStablecoin(t.tokenOut?.address)
        const amtIn = parseFloat(t.amountIn) || 0
        const amtOut = parseFloat(t.amountOut) || 0

        if (inIsStable && !outIsStable) {
            // Buying token with stablecoin
            totalStableIn += amtIn
            const sym = t.tokenOut?.symbol || 'UNKNOWN'
            if (!positions[sym]) positions[sym] = { bought: 0, sold: 0, spent: 0, received: 0 }
            positions[sym].bought += amtOut
            positions[sym].spent += amtIn
        } else if (!inIsStable && outIsStable) {
            // Selling token for stablecoin
            totalStableOut += amtOut
            const sym = t.tokenIn?.symbol || 'UNKNOWN'
            if (!positions[sym]) positions[sym] = { bought: 0, sold: 0, spent: 0, received: 0 }
            positions[sym].sold += amtIn
            positions[sym].received += amtOut
        }
        // token-to-token: tracked in positions but no direct USD PnL
    }

    const realizedPnL = totalStableOut - totalStableIn
    return { totalStableIn, totalStableOut, realizedPnL, positions, tradeCount: trades.length }
}

function isStablecoin(address) {
    if (!address) return false
    return !!STABLECOINS[address.toLowerCase()]
}

function formatUSD(n) {
    const sign = n >= 0 ? '+' : ''
    return `${sign}$${n.toFixed(2)}`
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2)
    const result = {
        json: false,
        reset: false,
        export: null,
        historyPath: process.env.TRADE_HISTORY_PATH || DEFAULT_HISTORY_PATH,
    }
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--json': result.json = true; break
            case '--reset': result.reset = true; break
            case '--export': result.export = args[++i]; break
            case '--history-path': result.historyPath = args[++i]; break
            case '--help': case '-h': printHelp(); process.exit(0)
        }
    }
    return result
}

function printHelp() {
    console.log(`
Usage: node trade-history.js [options]

Options:
  --json            Machine-readable JSON output
  --reset           Clear all trade history
  --export <file>   Export trades to CSV
  --history-path    Path to history file (default: config/trade-history.json)

Examples:
  node trade-history.js              # Show PnL summary
  node trade-history.js --json       # JSON output for agents
  node trade-history.js --export trades.csv
`)
}

async function main() {
    const args = parseArgs()

    if (args.reset) {
        saveHistory({ trades: [], startedAt: new Date().toISOString() }, args.historyPath)
        console.log('Trade history cleared.')
        return
    }

    const history = loadHistory(args.historyPath)
    const pnl = calculatePnL(history.trades)

    if (args.export) {
        const header = 'id,timestamp,orderUid,tokenIn,tokenOut,amountIn,amountOut,explorer'
        const rows = history.trades.map(t =>
            `${t.id},${t.timestamp},${t.orderUid || ''},${t.tokenIn?.symbol || ''},${t.tokenOut?.symbol || ''},${t.amountIn},${t.amountOut},${t.orderUid ? `${COW_EXPLORER_BASE}/${t.orderUid}` : ''}`
        )
        fs.writeFileSync(args.export, [header, ...rows].join('\n'))
        console.log(`Exported ${history.trades.length} trades to ${args.export}`)
        return
    }

    if (args.json) {
        console.log(JSON.stringify({
            startedAt: history.startedAt,
            tradeCount: pnl.tradeCount,
            totalStableIn: pnl.totalStableIn,
            totalStableOut: pnl.totalStableOut,
            realizedPnL: pnl.realizedPnL,
            positions: pnl.positions,
            trades: history.trades,
        }, null, 2))
        return
    }

    // Human-readable output
    console.log('\n=== Clawlett Trade History ===\n')
    console.log(`Trading since: ${history.startedAt || 'N/A'}`)
    console.log(`Total trades:  ${pnl.tradeCount}`)

    if (pnl.tradeCount === 0) {
        console.log('\nNo trades recorded yet. Execute a swap to start tracking.\n')
        return
    }

    console.log(`\nStable spent:    $${pnl.totalStableIn.toFixed(2)}`)
    console.log(`Stable received: $${pnl.totalStableOut.toFixed(2)}`)
    console.log(`Realized PnL:    ${formatUSD(pnl.realizedPnL)}`)

    if (Object.keys(pnl.positions).length > 0) {
        console.log('\n--- Positions ---')
        for (const [sym, pos] of Object.entries(pnl.positions)) {
            const net = pos.bought - pos.sold
            const avgCost = pos.bought > 0 ? (pos.spent / pos.bought).toFixed(4) : 'N/A'
            console.log(`  ${sym}: bought ${pos.bought.toFixed(6)}, sold ${pos.sold.toFixed(6)}, net ${net.toFixed(6)}, avg cost $${avgCost}`)
        }
    }

    console.log('\n--- Recent Trades ---')
    const recent = history.trades.slice(-10)
    for (const t of recent) {
        const time = new Date(t.timestamp).toLocaleString()
        const link = t.orderUid ? `order:${t.orderUid.slice(0, 10)}...` : 'N/A'
        console.log(`  #${t.id} [${time}] ${t.amountIn} ${t.tokenIn?.symbol || '?'} -> ${t.amountOut} ${t.tokenOut?.symbol || '?'} ${link}`)
    }
    console.log('')
}

main().catch(e => { console.error(e.message); process.exit(1) })
