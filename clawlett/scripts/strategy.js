#!/usr/bin/env node

/**
 * Autonomous trading strategy runner for Clawlett
 *
 * Built-in strategies:
 *   dca       — Dollar-cost average into a target token at fixed intervals
 *   rebalance — Maintain target allocation between two tokens
 *   limit     — Wait for a price target then execute a single swap
 *
 * All strategies use CoW Protocol for MEV-protected execution.
 * CoW orders are async (presign → batch → fill), so executions may
 * take several minutes. The strategy runner handles this automatically.
 *
 * Usage:
 *   node strategy.js --strategy dca --from USDC --to ETH --amount 10 --interval 3600
 *   node strategy.js --strategy rebalance --tokens ETH,USDC --target 50,50 --threshold 5
 *   node strategy.js --strategy limit --from ETH --to USDC --amount 0.1 --min-out 280
 *   node strategy.js --dry-run --strategy dca ...   # simulate without executing
 */

import { ethers } from 'ethers'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { VERIFIED_TOKENS, ERC20_ABI, resolveToken } from './tokens.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_RPC_URL = 'https://mainnet.base.org'
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'
const NATIVE_ETH = '0x0000000000000000000000000000000000000000'

// CoW orders can take up to 30 minutes to fill. Add buffer for RPC + presign.
const SWAP_EXEC_TIMEOUT_MS = 35 * 60 * 1000 // 35 minutes
const SWAP_QUOTE_TIMEOUT_MS = 60 * 1000     // 1 minute for quotes

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function parseArgs() {
    const args = process.argv.slice(2)
    const result = {
        strategy: null,
        from: null,
        to: null,
        amount: null,
        interval: 3600,       // seconds between DCA buys
        maxRounds: 0,         // 0 = unlimited
        tokens: null,         // comma-separated for rebalance
        target: null,         // comma-separated target %
        threshold: 5,         // rebalance threshold %
        minOut: null,         // limit order minimum output
        dryRun: false,
        json: false,
        configDir: process.env.WALLET_CONFIG_DIR || path.join(__dirname, '..', 'config'),
        rpc: process.env.BASE_RPC_URL || DEFAULT_RPC_URL,
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--strategy': case '-s': result.strategy = args[++i]; break
            case '--from': case '-f': result.from = args[++i]; break
            case '--to': case '-t': result.to = args[++i]; break
            case '--amount': case '-a': result.amount = args[++i]; break
            case '--interval': result.interval = parseInt(args[++i]); break
            case '--max-rounds': result.maxRounds = parseInt(args[++i]); break
            case '--tokens': result.tokens = args[++i].split(','); break
            case '--target': result.target = args[++i].split(',').map(Number); break
            case '--threshold': result.threshold = parseFloat(args[++i]); break
            case '--min-out': result.minOut = args[++i]; break
            case '--dry-run': result.dryRun = true; break
            case '--json': result.json = true; break
            case '--config-dir': case '-c': result.configDir = args[++i]; break
            case '--rpc': case '-r': result.rpc = args[++i]; break
            case '--help': case '-h': printHelp(); process.exit(0)
        }
    }
    return result
}

function printHelp() {
    console.log(`
Usage: node strategy.js --strategy <name> [options]

Strategies:
  dca         Dollar-cost average: buy fixed amount at intervals
  rebalance   Maintain target allocation between tokens
  limit       Execute once when price target is met

Common Options:
  --from, -f         Token to sell
  --to, -t           Token to buy
  --amount, -a       Amount per trade
  --dry-run          Simulate without executing
  --json             Machine-readable output
  --config-dir, -c   Config directory
  --rpc, -r          RPC URL

DCA Options:
  --interval <sec>   Seconds between buys (default: 3600)
  --max-rounds <n>   Stop after n buys (default: unlimited)

Rebalance Options:
  --tokens A,B       Token pair to rebalance
  --target 60,40     Target allocation percentages
  --threshold <pct>  Rebalance when off by this % (default: 5)

Limit Options:
  --min-out <amount> Minimum output to trigger execution

Examples:
  node strategy.js --strategy dca --from USDC --to ETH --amount 10 --interval 3600
  node strategy.js --strategy rebalance --tokens ETH,USDC --target 50,50
  node strategy.js --strategy limit --from ETH --to USDC --amount 0.1 --min-out 280
  node strategy.js --dry-run --strategy dca --from USDC --to AERO --amount 5
`)
}

function log(args, ...msg) {
    if (!args.json) console.log(...msg)
}

/**
 * Execute a swap via swap.js and return the result.
 * CoW orders are async — the swap script handles presign + polling internally,
 * so we need a long timeout to accommodate batch auction settlement.
 */
function executeSwap(from, to, amount, configDir, dryRun) {
    const swapPath = path.join(__dirname, 'swap.js')
    const swapArgs = ['--from', from, '--to', to, '--amount', amount, '--config-dir', configDir, '--json']
    if (!dryRun) swapArgs.push('--execute')

    try {
        const output = execFileSync('node', [swapPath, ...swapArgs], {
            encoding: 'utf8',
            timeout: dryRun ? SWAP_QUOTE_TIMEOUT_MS : SWAP_EXEC_TIMEOUT_MS,
        })
        try { return JSON.parse(output) } catch { return { raw: output.trim() } }
    } catch (e) {
        return { error: e.message, stderr: e.stderr?.trim() }
    }
}

/**
 * Get a quote without executing
 */
function getQuote(from, to, amount, configDir) {
    const swapPath = path.join(__dirname, 'swap.js')
    const swapArgs = ['--from', from, '--to', to, '--amount', amount, '--config-dir', configDir, '--json']

    try {
        const output = execFileSync('node', [swapPath, ...swapArgs], {
            encoding: 'utf8',
            timeout: SWAP_QUOTE_TIMEOUT_MS,
        })
        try { return JSON.parse(output) } catch { return null }
    } catch {
        return null
    }
}

/**
 * Read the Safe balance for a given token symbol
 */
async function getBalance(symbol, configDir, rpc) {
    const configPath = path.join(configDir, 'wallet.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const provider = new ethers.JsonRpcProvider(rpc)
    const safeAddress = config.safe

    const tokenInfo = await resolveToken(symbol, provider)
    const address = tokenInfo.address

    if (address.toLowerCase() === NATIVE_ETH) {
        // For ETH: return combined ETH + WETH (since CoW uses WETH)
        const ethBal = await provider.getBalance(safeAddress)
        const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, provider)
        const wethBal = await wethContract.balanceOf(safeAddress)
        return {
            symbol: 'ETH',
            balance: ethBal + wethBal,
            decimals: 18,
            formatted: ethers.formatUnits(ethBal + wethBal, 18),
        }
    }

    const contract = new ethers.Contract(address, ERC20_ABI, provider)
    const balance = await contract.balanceOf(safeAddress)
    return {
        symbol: tokenInfo.symbol,
        balance,
        decimals: tokenInfo.decimals,
        formatted: ethers.formatUnits(balance, tokenInfo.decimals),
    }
}

// ============================================================================
// STRATEGIES
// ============================================================================

async function runDCA(args) {
    const { from, to, amount, interval, maxRounds, configDir, dryRun } = args
    if (!from || !to || !amount) {
        console.error('DCA requires --from, --to, and --amount')
        process.exit(1)
    }

    log(args, `\n=== DCA Strategy ===`)
    log(args, `Buy ${amount} ${from} worth of ${to} every ${interval}s`)
    log(args, `Max rounds: ${maxRounds || 'unlimited'}`)
    if (dryRun) log(args, `[DRY RUN - no trades will execute]\n`)

    const results = []
    let round = 0

    while (true) {
        round++
        if (maxRounds > 0 && round > maxRounds) break

        log(args, `\n--- Round ${round} [${new Date().toISOString()}] ---`)

        const result = executeSwap(from, to, amount, configDir, dryRun)
        results.push({ round, timestamp: new Date().toISOString(), ...result })

        if (result.error) {
            log(args, `Round ${round} failed: ${result.error}`)
        } else if (result.status === 'fulfilled') {
            log(args, `Round ${round} filled: order ${result.orderUid || 'N/A'}`)
            log(args, `   Received: ${result.amountOut || 'N/A'} ${to}`)
        } else if (result.mode === 'quote') {
            log(args, `Round ${round} quote: ~${result.quote?.amountOut || 'N/A'} ${to}`)
        } else {
            log(args, `Round ${round} result: ${JSON.stringify(result)}`)
        }

        if (maxRounds > 0 && round >= maxRounds) break

        log(args, `Waiting ${interval}s until next round...`)
        await sleep(interval * 1000)
    }

    if (args.json) {
        console.log(JSON.stringify({ strategy: 'dca', rounds: results }, null, 2))
    } else {
        log(args, `\nDCA complete. ${results.length} rounds executed.`)
    }
}

async function runRebalance(args) {
    const { tokens, target, threshold, configDir, dryRun, rpc } = args
    if (!tokens || tokens.length !== 2 || !target || target.length !== 2) {
        console.error('Rebalance requires --tokens A,B and --target X,Y (percentages)')
        process.exit(1)
    }
    if (Math.abs(target[0] + target[1] - 100) > 0.01) {
        console.error('Target percentages must sum to 100')
        process.exit(1)
    }

    log(args, `\n=== Rebalance Strategy ===`)
    log(args, `Tokens: ${tokens[0]}/${tokens[1]}`)
    log(args, `Target: ${target[0]}%/${target[1]}%`)
    log(args, `Threshold: ${threshold}%`)
    if (dryRun) log(args, `[DRY RUN]\n`)

    // Step 1: Get current balances
    let balA, balB
    try {
        balA = await getBalance(tokens[0], configDir, rpc)
        balB = await getBalance(tokens[1], configDir, rpc)
    } catch (e) {
        console.error(`Failed to read balances: ${e.message}`)
        process.exit(1)
    }

    log(args, `${balA.symbol} balance: ${balA.formatted}`)
    log(args, `${balB.symbol} balance: ${balB.formatted}`)

    // Step 2: Get prices in USDC terms
    const quoteA = getQuote(tokens[0], 'USDC', '1', configDir)
    const quoteB = tokens[1].toUpperCase() === 'USDC'
        ? { quote: { amountOut: '1' } }
        : getQuote(tokens[1], 'USDC', '1', configDir)

    if (!quoteA?.quote?.amountOut || !quoteB?.quote?.amountOut) {
        console.error('Could not get price quotes for rebalance calculation.')
        if (args.json) console.log(JSON.stringify({ strategy: 'rebalance', error: 'quote_failed' }))
        process.exit(1)
    }

    const priceA = parseFloat(quoteA.quote.amountOut)
    const priceB = parseFloat(quoteB.quote.amountOut)
    const valueA = parseFloat(balA.formatted) * priceA
    const valueB = parseFloat(balB.formatted) * priceB
    const totalValue = valueA + valueB

    if (totalValue === 0) {
        console.error('Total portfolio value is $0. Fund the Safe first.')
        process.exit(1)
    }

    const currentPctA = (valueA / totalValue) * 100
    const currentPctB = (valueB / totalValue) * 100
    const driftA = currentPctA - target[0]

    log(args, `\nPrice ${tokens[0]}: ~$${priceA.toFixed(4)}`)
    log(args, `Price ${tokens[1]}: ~$${priceB.toFixed(4)}`)
    log(args, `\nPortfolio value: ~$${totalValue.toFixed(2)}`)
    log(args, `Current: ${tokens[0]} ${currentPctA.toFixed(1)}% / ${tokens[1]} ${currentPctB.toFixed(1)}%`)
    log(args, `Target:  ${tokens[0]} ${target[0]}% / ${tokens[1]} ${target[1]}%`)
    log(args, `Drift:   ${driftA >= 0 ? '+' : ''}${driftA.toFixed(1)}% on ${tokens[0]}`)

    if (Math.abs(driftA) < threshold) {
        log(args, `\nWithin threshold (${threshold}%). No rebalance needed.`)
        if (args.json) {
            console.log(JSON.stringify({
                strategy: 'rebalance', action: 'none',
                current: { [tokens[0]]: currentPctA, [tokens[1]]: currentPctB },
                target: { [tokens[0]]: target[0], [tokens[1]]: target[1] },
                drift: driftA,
            }, null, 2))
        }
        return
    }

    // Step 3: Calculate and execute the swap
    // If driftA > 0, we have too much A → sell A for B
    // If driftA < 0, we have too much B → sell B for A
    const sellToken = driftA > 0 ? tokens[0] : tokens[1]
    const buyToken = driftA > 0 ? tokens[1] : tokens[0]
    const sellPrice = driftA > 0 ? priceA : priceB
    const excessUSD = Math.abs(driftA) / 100 * totalValue / 2 // sell half the excess to center
    const sellAmount = (excessUSD / sellPrice).toFixed(6)

    log(args, `\nAction: sell ${sellAmount} ${sellToken} for ${buyToken}`)

    if (dryRun) {
        log(args, `[DRY RUN] Would execute: swap ${sellAmount} ${sellToken} → ${buyToken}`)
        if (args.json) {
            console.log(JSON.stringify({
                strategy: 'rebalance', action: 'swap', dryRun: true,
                sell: { token: sellToken, amount: sellAmount },
                buy: { token: buyToken },
                drift: driftA,
            }, null, 2))
        }
        return
    }

    const result = executeSwap(sellToken, buyToken, sellAmount, configDir, false)

    if (args.json) {
        console.log(JSON.stringify({
            strategy: 'rebalance', action: 'swap',
            sell: { token: sellToken, amount: sellAmount },
            buy: { token: buyToken },
            drift: driftA,
            result,
        }, null, 2))
    } else {
        if (result.status === 'fulfilled') {
            log(args, `Rebalance complete! Order: ${result.orderUid || 'N/A'}`)
        } else if (result.error) {
            log(args, `Rebalance failed: ${result.error}`)
        } else {
            log(args, `Rebalance result: ${JSON.stringify(result)}`)
        }
    }
}

async function runLimit(args) {
    const { from, to, amount, minOut, configDir, dryRun } = args
    if (!from || !to || !amount || !minOut) {
        console.error('Limit requires --from, --to, --amount, and --min-out')
        process.exit(1)
    }

    log(args, `\n=== Limit Order Strategy ===`)
    log(args, `Sell ${amount} ${from} for ${to} when output >= ${minOut}`)
    if (dryRun) log(args, `[DRY RUN]\n`)

    const pollInterval = 60 // seconds
    let attempts = 0

    while (true) {
        attempts++
        log(args, `\n[${new Date().toISOString()}] Checking price (attempt ${attempts})...`)

        const quote = getQuote(from, to, amount, configDir)
        if (!quote?.quote?.amountOut) {
            log(args, 'Quote failed, retrying...')
            await sleep(pollInterval * 1000)
            continue
        }

        const rawOut = quote.quote.amountOut
        log(args, `Current output: ${rawOut} ${to}`)

        const numOut = parseFloat(rawOut) || 0
        const numMin = parseFloat(minOut)

        if (numOut >= numMin) {
            log(args, `Target met! ${numOut} >= ${minOut}`)

            if (dryRun) {
                log(args, '[DRY RUN] Would execute swap now.')
                if (args.json) console.log(JSON.stringify({ strategy: 'limit', triggered: true, dryRun: true, quote: rawOut }))
                return
            }

            const result = executeSwap(from, to, amount, configDir, false)
            if (args.json) {
                console.log(JSON.stringify({ strategy: 'limit', triggered: true, ...result }, null, 2))
            } else {
                if (result.status === 'fulfilled') {
                    log(args, `Limit order filled! Order: ${result.orderUid || 'N/A'}`)
                } else if (result.error) {
                    log(args, `Execution failed: ${result.error}`)
                } else {
                    log(args, `Result: ${JSON.stringify(result)}`)
                }
            }
            return
        }

        log(args, `Below target (${numOut} < ${minOut}). Waiting ${pollInterval}s...`)
        await sleep(pollInterval * 1000)
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = parseArgs()

    if (!args.strategy) {
        console.error('Error: --strategy is required')
        printHelp()
        process.exit(1)
    }

    switch (args.strategy) {
        case 'dca': return runDCA(args)
        case 'rebalance': return runRebalance(args)
        case 'limit': return runLimit(args)
        default:
            console.error(`Unknown strategy: ${args.strategy}`)
            console.error('Available: dca, rebalance, limit')
            process.exit(1)
    }
}

main().catch(e => { console.error(e.message); process.exit(1) })
