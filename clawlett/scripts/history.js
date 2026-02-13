/**
 * Trade History Logger
 * 
 * Logs all trades to a JSON file for tracking and PnL analysis.
 * 
 * Usage:
 *   import { logTrade, getHistory, getPnL } from './history.js'
 *   
 *   // Log a trade
 *   logTrade({ from: 'ETH', to: 'USDC', amountIn: '0.1', amountOut: '195.50' })
 *   
 *   // Get trade history
 *   const trades = getHistory()
 *   
 *   // Calculate PnL
 *   const pnl = getPnL()
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_HISTORY_FILE = path.join(__dirname, '..', 'config', 'trade_history.json')

/**
 * Log a completed trade
 * @param {Object} trade - Trade details
 * @param {string} trade.from - Source token symbol
 * @param {string} trade.to - Destination token symbol  
 * @param {string} trade.amountIn - Amount sold
 * @param {string} trade.amountOut - Amount received
 * @param {string} [trade.txHash] - Transaction hash
 * @param {string} [trade.orderUid] - CoW Protocol order UID
 * @param {string} [historyFile] - Custom history file path
 */
export function logTrade(trade, historyFile = DEFAULT_HISTORY_FILE) {
  const history = loadHistory(historyFile)

  const entry = {
    id: history.trades.length + 1,
    timestamp: new Date().toISOString(),
    from: trade.from,
    to: trade.to,
    amountIn: trade.amountIn,
    amountOut: trade.amountOut,
    txHash: trade.txHash || null,
    orderUid: trade.orderUid || null,
  }

  history.trades.push(entry)
  history.lastUpdated = entry.timestamp

  saveHistory(history, historyFile)
  return entry
}

/**
 * Get trade history
 * @param {Object} [options] - Filter options
 * @param {number} [options.limit] - Max trades to return
 * @param {string} [options.token] - Filter by token (from or to)
 * @param {string} [options.since] - Filter trades after this ISO timestamp
 * @param {string} [historyFile] - Custom history file path
 * @returns {Array} Array of trade entries
 */
export function getHistory(options = {}, historyFile = DEFAULT_HISTORY_FILE) {
  const history = loadHistory(historyFile)
  let trades = [...history.trades]

  // Apply filters
  if (options.token) {
    const token = options.token.toUpperCase()
    trades = trades.filter(t => 
      t.from.toUpperCase() === token || t.to.toUpperCase() === token
    )
  }

  if (options.since) {
    const sinceDate = new Date(options.since)
    trades = trades.filter(t => new Date(t.timestamp) >= sinceDate)
  }

  // Sort newest first
  trades.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

  // Apply limit
  if (options.limit) {
    trades = trades.slice(0, options.limit)
  }

  return trades
}

/**
 * Calculate PnL summary
 * @param {string} [historyFile] - Custom history file path
 * @returns {Object} PnL summary by token
 */
export function getPnL(historyFile = DEFAULT_HISTORY_FILE) {
  const trades = getHistory({}, historyFile)
  const balances = {}

  for (const trade of trades) {
    // Subtract what we sold
    balances[trade.from] = (balances[trade.from] || 0) - parseFloat(trade.amountIn)
    // Add what we received
    balances[trade.to] = (balances[trade.to] || 0) + parseFloat(trade.amountOut)
  }

  return {
    totalTrades: trades.length,
    firstTrade: trades.length > 0 ? trades[trades.length - 1].timestamp : null,
    lastTrade: trades.length > 0 ? trades[0].timestamp : null,
    netChanges: balances,
  }
}

/**
 * Clear trade history
 * @param {string} [historyFile] - Custom history file path
 */
export function clearHistory(historyFile = DEFAULT_HISTORY_FILE) {
  const history = {
    version: 1,
    trades: [],
    lastUpdated: new Date().toISOString(),
  }
  saveHistory(history, historyFile)
}

// Internal helpers

function loadHistory(historyFile) {
  try {
    if (fs.existsSync(historyFile)) {
      return JSON.parse(fs.readFileSync(historyFile, 'utf8'))
    }
  } catch (e) {
    console.warn(`Warning: Could not load history file: ${e.message}`)
  }

  return {
    version: 1,
    trades: [],
    lastUpdated: null,
  }
}

function saveHistory(history, historyFile) {
  const dir = path.dirname(historyFile)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2))
}

export default {
  logTrade,
  getHistory,
  getPnL,
  clearHistory,
}
