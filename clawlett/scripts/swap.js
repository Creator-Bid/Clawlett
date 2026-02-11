#!/usr/bin/env node

/**
 * Swap tokens via Aerodrome (via Safe + Zodiac Roles)
 *
 * Features:
 * - Resolves token symbols to addresses
 * - Safeguards for common tokens (ETH, USDC, USDT, etc.)
 * - Gets quote before execution
 * - Outputs confirmation request for user approval
 *
 * Usage:
 *   node swap.js --from ETH --to USDC --amount 0.1
 *   node swap.js --from USDC --to ETH --amount 100 --execute
 */

import { ethers } from 'ethers'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_RPC_URL = 'https://mainnet.base.org'

// ============================================================================
// VERIFIED TOKENS - Safeguard against scam tokens
// ============================================================================
const VERIFIED_TOKENS = {
    'ETH': '0x0000000000000000000000000000000000000000',  // Native ETH
    'WETH': '0x4200000000000000000000000000000000000006',
    'USDC': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'USDT': '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    'DAI': '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    'USDS': '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc',
    'AERO': '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    'cbBTC': '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    'VIRTUAL': '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
    'DEGEN': '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
    'BRETT': '0x532f27101965dd16442E59d40670FaF5eBB142E4',
    'TOSHI': '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
    'WELL': '0xA88594D404727625A9437C3f886C7643872296AE',
    'BID': '0xa1832f7f4e534ae557f9b5ab76de54b1873e498b',
}

const TOKEN_ALIASES = {
    'ETHEREUM': 'ETH',
    'ETHER': 'ETH',
    'USD COIN': 'USDC',
    'TETHER': 'USDT',
}

const PROTECTED_SYMBOLS = ['ETH', 'WETH', 'USDC', 'USDT', 'DAI', 'USDS', 'AERO', 'cbBTC', 'BID']

// Contracts
const CONTRACTS = {
    AeroUniversalRouter: '0x6Df1c91424F79E40E33B1A48F0687B666bE71075',
    ZodiacHelpers: '0xc235D2475E4424F277B53D19724E2453a8686C54',
    WETH: '0x4200000000000000000000000000000000000006',
}

// ABIs
const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
]


const ROLES_ABI = [
    'function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)',
]

const APPROVAL_HELPER_ABI = [
    'function approveForRouter(address token, uint256 amount) external',
    'function executeSwap(bytes commands, bytes[] inputs, uint256 deadline) external payable',
]

// ============================================================================
// TOKEN RESOLUTION
// ============================================================================

async function resolveToken(token, provider) {
    token = token.trim()

    if (token.startsWith('0x') && token.length === 42) {
        return resolveByAddress(token, provider)
    }

    const symbol = token.toUpperCase().replace(/^\$/, '')
    const aliasedSymbol = TOKEN_ALIASES[symbol] || symbol

    if (VERIFIED_TOKENS[aliasedSymbol]) {
        const address = VERIFIED_TOKENS[aliasedSymbol]
        const tokenContract = new ethers.Contract(address, ERC20_ABI, provider)
        const [onChainSymbol, decimals] = await Promise.all([
            tokenContract.symbol(),
            tokenContract.decimals(),
        ])
        return {
            address,
            symbol: onChainSymbol,
            decimals: Number(decimals),
            verified: true,
        }
    }

    if (PROTECTED_SYMBOLS.includes(aliasedSymbol)) {
        throw new Error(
            `⚠️ SECURITY: "${symbol}" is a protected token but no verified address found.\n` +
            `This could be a scam token. Use contract address directly if intended.`
        )
    }

    throw new Error(
        `Token "${symbol}" not found in verified list.\n` +
        `Use contract address directly: --from 0x...`
    )
}

async function resolveByAddress(address, provider) {
    address = ethers.getAddress(address)

    const verifiedEntry = Object.entries(VERIFIED_TOKENS).find(
        ([, addr]) => addr.toLowerCase() === address.toLowerCase()
    )

    const tokenContract = new ethers.Contract(address, ERC20_ABI, provider)
    const [symbol, decimals] = await Promise.all([
        tokenContract.symbol(),
        tokenContract.decimals(),
    ])

    const result = {
        address,
        symbol,
        decimals: Number(decimals),
        verified: !!verifiedEntry,
    }

    if (!verifiedEntry && PROTECTED_SYMBOLS.includes(symbol.toUpperCase())) {
        result.warning =
            `⚠️ WARNING: Token has symbol "${symbol}" but is NOT the verified ${symbol}.\n` +
            `Verified address: ${VERIFIED_TOKENS[symbol.toUpperCase()]}\n` +
            `You provided: ${address}\n` +
            `This could be a SCAM TOKEN.`
    }

    return result
}

// ============================================================================
// QUOTE (via API)
// ============================================================================

const QUOTE_API_URL = process.env.QUOTE_API_URL || 'https://we-395242cd474c4e0f8b93ca567e0b58ce.ecs.eu-central-1.on.aws/'

async function getQuote(provider, tokenIn, tokenOut, amountIn, safeAddress, slippage) {
    const response = await fetch(`${QUOTE_API_URL}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            amountIn: amountIn.toString(),
            recipient: safeAddress,
            slippage: slippage || 0.05,
            chainId: '8453',
        }),
    })

    const data = await response.json()

    if (!response.ok || data.error) {
        throw new Error(data.error || 'Quote failed')
    }

    return {
        amountOut: BigInt(data.quote),
        minAmountOut: data.minAmountOut ? BigInt(data.minAmountOut) : null,
        route: data.path,
        isMultiHop: data.isMultiHop,
        calldata: data.calldata,  // Ready-to-use calldata for Universal Router
        value: data.value ? BigInt(data.value) : 0n,  // ETH value to send (for ETH-in swaps)
    }
}

function formatAmount(amount, decimals, symbol) {
    const formatted = ethers.formatUnits(amount, decimals)
    const num = parseFloat(formatted)
    if (num < 0.01) return `${formatted} ${symbol}`
    return `${num.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`
}

// ============================================================================
// MAIN
// ============================================================================

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
        from: null,
        to: null,
        amount: null,
        configDir: process.env.WALLET_CONFIG_DIR || path.join(__dirname, '..', 'config'),
        rpc: process.env.BASE_RPC_URL || DEFAULT_RPC_URL,
        slippage: 0.05, // 5% - value between 0 and 0.5
        execute: false,
        json: false,
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--from':
            case '-f':
                result.from = args[++i]
                break
            case '--to':
            case '-t':
                result.to = args[++i]
                break
            case '--amount':
            case '-a':
                result.amount = args[++i]
                break
            case '--slippage':
                result.slippage = parseFloat(args[++i])
                break
            case '--execute':
            case '-x':
                result.execute = true
                break
            case '--json':
                result.json = true
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
Usage: node swap.js --from <TOKEN> --to <TOKEN> --amount <AMOUNT> [--execute]

Arguments:
  --from, -f       Token to swap from (symbol or address)
  --to, -t         Token to swap to (symbol or address)
  --amount, -a     Amount to swap
  --slippage       Slippage 0-0.5 (default: 0.05 = 5%)
  --execute, -x    Execute swap (default: quote only)
  --json          JSON output mode (agent-friendly)
  --config-dir, -c Config directory
  --rpc, -r        RPC URL (default: ${DEFAULT_RPC_URL})

Verified Tokens:
  ETH, WETH, USDC, USDT, DAI, USDS, AERO, cbBTC, VIRTUAL, DEGEN, BRETT, TOSHI, WELL

Examples:
  node swap.js --from ETH --to USDC --amount 0.1
  node swap.js --from USDC --to ETH --amount 100 --execute
`)
}

async function main() {
    const args = parseArgs()
    const log = (...x) => { if (!args.json) console.log(...x) }

    if (!args.from || !args.to || !args.amount) {
        console.error('Error: --from, --to, and --amount are required')
        printHelp()
        process.exit(1)
    }

    let config
    try {
        config = loadConfig(args.configDir)
    } catch (error) {
        console.error(`Error: ${error.message}`)
        process.exit(1)
    }

    const provider = new ethers.JsonRpcProvider(args.rpc)

    log('\n🔍 Resolving tokens...\n')

    let tokenIn, tokenOut
    try {
        tokenIn = await resolveToken(args.from, provider)
        log(`From: ${tokenIn.symbol} ${tokenIn.verified ? '✅' : '⚠️'}`)
        log(`      ${tokenIn.address}`)
        if (tokenIn.warning) log(`\n${tokenIn.warning}\n`)
    } catch (error) {
        console.error(`\n❌ ${error.message}`)
        process.exit(1)
    }

    try {
        tokenOut = await resolveToken(args.to, provider)
        log(`To:   ${tokenOut.symbol} ${tokenOut.verified ? '✅' : '⚠️'}`)
        log(`      ${tokenOut.address}`)
        if (tokenOut.warning) log(`\n${tokenOut.warning}\n`)
    } catch (error) {
        console.error(`\n❌ ${error.message}`)
        process.exit(1)
    }

    const amountIn = ethers.parseUnits(args.amount, tokenIn.decimals)
    log(`\nAmount: ${formatAmount(amountIn, tokenIn.decimals, tokenIn.symbol)}`)

    // Check balance
    const safeAddress = config.safe
    const NATIVE_ETH = '0x0000000000000000000000000000000000000000'
    let balance
    if (tokenIn.address.toLowerCase() === NATIVE_ETH || tokenIn.address.toLowerCase() === CONTRACTS.WETH.toLowerCase()) {
        balance = await provider.getBalance(safeAddress)
    } else {
        const tokenContract = new ethers.Contract(tokenIn.address, ERC20_ABI, provider)
        balance = await tokenContract.balanceOf(safeAddress)
    }
    log(`Safe balance: ${formatAmount(balance, tokenIn.decimals, tokenIn.symbol)}`)

    if (balance < amountIn) {
        console.error(`\n❌ Insufficient balance`)
        process.exit(1)
    }

    log('\n📊 Getting quote...\n')

    let quote
    try {
        quote = await getQuote(provider, tokenIn, tokenOut, amountIn, safeAddress, args.slippage)
    } catch (error) {
        console.error(`❌ ${error.message}`)
        process.exit(1)
    }

    const minAmountOut = quote.minAmountOut || (quote.amountOut * BigInt(100 - args.slippage) / 100n)

    log('═══════════════════════════════════════════════════════')
    log('                    SWAP SUMMARY')
    log('═══════════════════════════════════════════════════════')
    log(`  You pay:      ${formatAmount(amountIn, tokenIn.decimals, tokenIn.symbol)}`)
    log(`  You receive:  ${formatAmount(quote.amountOut, tokenOut.decimals, tokenOut.symbol)}`)
    log(`  Min receive:  ${formatAmount(minAmountOut, tokenOut.decimals, tokenOut.symbol)} (${args.slippage}% slippage)`)
    log(`  Route:        ${quote.isMultiHop ? `${tokenIn.symbol} → ... → ${tokenOut.symbol}` : `${tokenIn.symbol} → ${tokenOut.symbol}`}`)
    log('═══════════════════════════════════════════════════════')

    if (!args.execute) {
        if (args.json) {
            console.log(JSON.stringify({
                mode: 'quote',
                from: { symbol: tokenIn.symbol, address: tokenIn.address, amount: args.amount },
                to: { symbol: tokenOut.symbol, address: tokenOut.address },
                quote: {
                    amountOut: quote.amountOut.toString(),
                    minAmountOut: minAmountOut.toString(),
                    slippage: args.slippage,
                    route: quote.route || null,
                    isMultiHop: !!quote.isMultiHop,
                },
            }, null, 2))
        } else {
            log('\n📋 QUOTE ONLY - Add --execute to perform the swap')
            log(`\nTo execute: node swap.js --from "${args.from}" --to "${args.to}" --amount ${args.amount} --execute`)
        }
        process.exit(0)
    }

    log('\n🚀 Executing swap...\n')

    const agentPkPath = path.join(args.configDir, 'agent.pk')
    if (!fs.existsSync(agentPkPath)) {
        console.error('Error: Agent private key not found')
        process.exit(1)
    }
    let privateKey = fs.readFileSync(agentPkPath, 'utf8').trim()
    if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey

    const wallet = new ethers.Wallet(privateKey, provider)
    const roles = new ethers.Contract(config.roles, ROLES_ABI, wallet)

    const isETHIn = tokenIn.address.toLowerCase() === NATIVE_ETH
    const isETHOut = tokenOut.address.toLowerCase() === NATIVE_ETH

    // Build executeSwap calldata for ApprovalHelper (delegatecall)
    if (!quote.calldata) {
        console.error('❌ Quote API did not return calldata.')
        process.exit(1)
    }

    // API returns execute() calldata, replace selector with executeSwap()
    // execute: 0x3593564c, executeSwap: 0xf23674e8
    let swapCalldata = quote.calldata
    if (swapCalldata.startsWith('0x3593564c')) {
        swapCalldata = '0xf23674e8' + swapCalldata.slice(10)
    }
    const ethValue = quote.value ? BigInt(quote.value) : (isETHIn ? amountIn : 0n)

    // Handle approval for the router we're using
    if (!isETHIn) {
        const tokenContract = new ethers.Contract(tokenIn.address, ERC20_ABI, provider)
        let allowance = 0n
        try {
            allowance = await tokenContract.allowance(safeAddress, CONTRACTS.AeroUniversalRouter)
        } catch {
            // Some tokens have issues with allowance checks, assume 0
        }

        if (allowance < amountIn) {
            log(`Approving token for router...`)
            const approvalInterface = new ethers.Interface(APPROVAL_HELPER_ABI)
            const approveData = approvalInterface.encodeFunctionData('approveForRouter', [
                tokenIn.address,
                ethers.MaxUint256,
            ])

            const approveTx = await roles.execTransactionWithRole(
                CONTRACTS.ZodiacHelpers,
                0n,
                approveData,
                1, // delegatecall
                config.roleKey,
                true
            )
            await approveTx.wait()
            log('Approved!')
        }
    }

    // Execute swap via delegatecall to ZodiacHelpers.executeSwap
    const tx = await roles.execTransactionWithRole(
        CONTRACTS.ZodiacHelpers,
        ethValue,
        swapCalldata,
        1,  // delegatecall
        config.roleKey,
        true
    )

    log(`Transaction: ${tx.hash}`)
    const receipt = await tx.wait()

    if (receipt.status === 1) {
        let newBalance
        if (isETHOut) {
            newBalance = await provider.getBalance(safeAddress)
        } else {
            const outContract = new ethers.Contract(tokenOut.address, ERC20_ABI, provider)
            newBalance = await outContract.balanceOf(safeAddress)
        }

        if (args.json) {
            console.log(JSON.stringify({
                mode: 'execute',
                status: 'success',
                txHash: tx.hash,
                tokenOut: tokenOut.symbol,
                newBalance: newBalance.toString(),
                decimals: tokenOut.decimals,
            }, null, 2))
        } else {
            log('\n✅ SWAP COMPLETE')
            log(`   New ${tokenOut.symbol} balance: ${formatAmount(newBalance, tokenOut.decimals, tokenOut.symbol)}`)
            log(`   Tx: ${tx.hash}`)
        }
    } else {
        if (args.json) {
            console.log(JSON.stringify({ mode: 'execute', status: 'failed' }, null, 2))
        }
        console.error('\n❌ Transaction failed')
        process.exit(1)
    }
}

main().catch(error => {
    console.error(`\n❌ Error: ${error.message}`)
    process.exit(1)
})
