#!/usr/bin/env node

/**
 * Check Safe balances
 *
 * Usage:
 *   node balance.js              # ETH balance
 *   node balance.js --token USDC # Specific token
 *   node balance.js --all        # All verified tokens
 */

import { ethers } from 'ethers'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { VERIFIED_TOKENS } from './lib/tokens.js'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_RPC_URL = 'https://mainnet.base.org'

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
]

function loadConfig(configDir) {
    const configPath = path.join(configDir, 'wallet.json')
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${configPath}\nRun initialize.js first.`)
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function parseArgs() {
    const args = process.argv.slice(2)
    const result = {
        token: null,
        all: false,
        configDir: process.env.WALLET_CONFIG_DIR || path.join(__dirname, '..', 'config'),
        rpc: process.env.BASE_RPC_URL || DEFAULT_RPC_URL,
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--token':
            case '-t':
                result.token = args[++i]
                break
            case '--all':
            case '-a':
                result.all = true
                break
            case '--config-dir':
            case '-c':
                result.configDir = args[++i]
                break
            case '--rpc':
            case '-r':
                result.rpc = args[++i]
                break
            case '--help':
            case '-h':
                printHelp()
                process.exit(0)
        }
    }

    return result
}

function printHelp() {
    console.log(`
Usage: node balance.js [options]

Options:
  --token, -t      Check specific token balance
  --all, -a        Check all verified token balances
  --config-dir, -c Config directory
  --rpc, -r        RPC URL (default: ${DEFAULT_RPC_URL})

Examples:
  node balance.js              # ETH balance only
  node balance.js --token USDC # USDC balance
  node balance.js --all        # All token balances
`)
}

function formatAmount(amount, decimals, symbol) {
    const formatted = ethers.formatUnits(amount, decimals)
    const num = parseFloat(formatted)
    if (num === 0) return `0 ${symbol}`
    if (num < 0.0001) return `${formatted} ${symbol}`
    return `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`
}

async function getTokenBalance(provider, safeAddress, tokenAddress) {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
    const [symbol, decimals, balance] = await Promise.all([
        contract.symbol(),
        contract.decimals(),
        contract.balanceOf(safeAddress),
    ])
    return { symbol, decimals: Number(decimals), balance }
}

async function main() {
    const args = parseArgs()

    let config
    try {
        config = loadConfig(args.configDir)
    } catch (error) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
    }

    const provider = new ethers.JsonRpcProvider(args.rpc)
    const safeAddress = config.safe

    console.log(`\nSafe: ${safeAddress}\n`)

    // Always show ETH
    const ethBalance = await provider.getBalance(safeAddress)
    console.log(`ETH:    ${formatAmount(ethBalance, 18, 'ETH')}`)

    if (args.all) {
        // Show all verified tokens
        console.log('')
        for (const [symbol, address] of Object.entries(VERIFIED_TOKENS)) {
            if (symbol === 'ETH') continue
            try {
                const { balance, decimals } = await getTokenBalance(provider, safeAddress, address)
                if (balance > 0n) {
                    console.log(`${symbol.padEnd(8)} ${formatAmount(balance, decimals, symbol)}`)
                }
            } catch {
                // Token might not exist or have issues
            }
        }
    } else if (args.token) {
        // Show specific token
        const symbol = args.token.toUpperCase().replace(/^\$/, '')
        let address = VERIFIED_TOKENS[symbol]

        if (!address) {
            if (args.token.startsWith('0x') && args.token.length === 42) {
                address = args.token
            } else {
                console.error(`\nToken "${args.token}" not found. Use address or one of:`)
                console.error(Object.keys(VERIFIED_TOKENS).join(', '))
                process.exit(1)
            }
        }

        try {
            const { symbol: tokenSymbol, balance, decimals } = await getTokenBalance(provider, safeAddress, address)
            console.log(`${tokenSymbol}:    ${formatAmount(balance, decimals, tokenSymbol)}`)
        } catch (error) {
            console.error(`\nFailed to get token balance: ${error.message}`)
            process.exit(1)
        }
    }

    console.log('')
}

main().catch(error => {
    console.error(`\n❌ Error: ${error.message}`)
    process.exit(1)
})
