#!/usr/bin/env node

/**
 * Token Whitelist Manager for Clawlett (V3 — Registry-based)
 *
 * Manages the token whitelist directly from the command line.
 * With --execute, signs and submits the Safe transaction on-chain — no JSON upload needed.
 *
 * Usage:
 *   # Show current whitelist:
 *   node manage-whitelist.js --show
 *
 *   # Add a token (sign + execute directly):
 *   node manage-whitelist.js --add 0xTokenAddress --execute
 *
 *   # Remove a token:
 *   node manage-whitelist.js --remove 0xTokenAddress --execute
 *
 *   # Permission swap (one-time after deployment):
 *   node manage-whitelist.js --setup 0xRegistryAddr 0xHelpersAddr --execute
 *
 *   # Update wallet.json:
 *   node manage-whitelist.js --finalize 0xHelpersAddr 0xRegistryAddr
 */

import { ethers } from 'ethers'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import readline from 'readline'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RPC_URL = 'https://mainnet.base.org'
const CONFIG_DIR = process.env.WALLET_CONFIG_DIR || path.join(__dirname, '..', 'config')
const MULTISEND = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761'

// Role key: keccak256("WalletSwapper")
const ROLE_KEY = ethers.keccak256(ethers.toUtf8Bytes('WalletSwapper'))

const ExecutionOptions = {
    None: 0,
    Send: 1,
    DelegateCall: 2,
    Both: 3,
}

// ABIs
const REGISTRY_ABI = [
    'function addToken(address token)',
    'function removeToken(address token)',
    'function addTokens(address[] tokens)',
    'function isWhitelisted(address token) view returns (bool)',
    'function getAllTokens() view returns (address[])',
    'function getTokenCount() view returns (uint256)',
    'function owner() view returns (address)',
]

const ROLES_ABI = [
    'function scopeTarget(bytes32 roleKey, address targetAddress)',
    'function allowTarget(bytes32 roleKey, address targetAddress, uint8 options)',
    'function revokeTarget(bytes32 roleKey, address targetAddress)',
]

const SAFE_ABI = [
    'function nonce() view returns (uint256)',
    'function getThreshold() view returns (uint256)',
    'function isOwner(address owner) view returns (bool)',
    'function getOwners() view returns (address[])',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
    'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
]

const MULTISEND_ABI = [
    'function multiSend(bytes transactions)',
]

const ERC20_ABI = [
    'function symbol() view returns (string)',
]

// ============================================================================
// Config helpers
// ============================================================================

function loadConfig() {
    const configPath = path.join(CONFIG_DIR, 'wallet.json')
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${configPath}\nRun initialize.js first.`)
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function saveConfig(config) {
    const configPath = path.join(CONFIG_DIR, 'wallet.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// ============================================================================
// Resolve token symbol
// ============================================================================

async function resolveSymbol(address, provider) {
    try {
        const contract = new ethers.Contract(address, ERC20_ABI, provider)
        return await contract.symbol()
    } catch {
        return '???'
    }
}

// ============================================================================
// Prompt for private key (hidden input)
// ============================================================================

function promptKey(question) {
    return new Promise((resolve) => {
        process.stdout.write(question)
        process.stdin.setRawMode(true)
        process.stdin.resume()

        let key = ''
        const onData = (chunk) => {
            const str = chunk.toString()
            // Iterate char-by-char (handles pasted text correctly)
            for (const c of str) {
                if (c === '\n' || c === '\r') {
                    process.stdin.setRawMode(false)
                    process.stdin.pause()
                    process.stdin.removeListener('data', onData)
                    process.stdout.write('\n')
                    resolve(key.trim())
                    return
                } else if (c === '\u007F' || c === '\b') {
                    if (key.length > 0) {
                        key = key.slice(0, -1)
                        process.stdout.write('\b \b')
                    }
                } else if (c === '\u0003') {
                    process.stdout.write('\n')
                    process.exit(1)
                } else if (c.charCodeAt(0) >= 32) {
                    // Only printable characters (ignores escape sequences)
                    key += c
                    process.stdout.write('*')
                }
            }
        }
        process.stdin.on('data', onData)
    })
}

// ============================================================================
// Execute Safe transaction directly (1-of-1 Safe)
// ============================================================================

async function execSafeTx(safeAddress, to, value, data, operation, rpc) {
    const pk = await promptKey('Enter Safe owner private key: ')
    const provider = new ethers.JsonRpcProvider(rpc)
    const wallet = new ethers.Wallet(pk, provider)

    const safe = new ethers.Contract(safeAddress, SAFE_ABI, provider)

    // Verify threshold is 1 (direct execution only)
    const threshold = await safe.getThreshold()
    if (threshold !== 1n) {
        throw new Error(`Safe threshold is ${threshold}, direct execution only works with threshold 1`)
    }

    // Verify the key belongs to a Safe owner
    const isOwner = await safe.isOwner(wallet.address)
    if (!isOwner) {
        const owners = await safe.getOwners()
        throw new Error(
            `Address ${wallet.address} is NOT a Safe owner.\n` +
            `  Safe owners: ${owners.join(', ')}\n` +
            `  Check that you entered the correct private key.`
        )
    }

    console.log(`\n  Signer: ${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`)

    // Get nonce and compute transaction hash
    const nonce = await safe.nonce()
    const txHash = await safe.getTransactionHash(
        to, value, data, operation,
        0, 0, 0,           // safeTxGas, baseGas, gasPrice
        ethers.ZeroAddress, // gasToken
        ethers.ZeroAddress, // refundReceiver
        nonce,
    )

    // Sign using eth_sign (EIP-191 personal message prefix)
    // wallet.signMessage() internally does: sign(keccak256("\x19Ethereum Signed Message:\n32" + txHash))
    const rawSig = await wallet.signMessage(ethers.getBytes(txHash))
    const sig = ethers.Signature.from(rawSig)

    // Safe expects v + 4 for eth_sign type signatures
    const sigBytes = ethers.concat([
        sig.r,
        sig.s,
        ethers.toBeHex(sig.v + 4, 1),
    ])

    console.log(`  Submitting Safe transaction...`)

    const tx = await safe.connect(wallet).execTransaction(
        to, value, data, operation,
        0, 0, 0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        sigBytes,
    )

    console.log(`  Tx hash: ${tx.hash}`)
    console.log(`  Waiting for confirmation...`)

    const receipt = await tx.wait()
    console.log(`  Confirmed in block ${receipt.blockNumber}`)

    return receipt
}

// ============================================================================
// MultiSend encoding (for batched Safe transactions)
// ============================================================================

function encodeMultiSendTx(operation, to, value, data) {
    return ethers.solidityPacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [operation, to, value, ethers.dataLength(data), data],
    )
}

function encodeMultiSend(transactions) {
    const packed = ethers.concat(
        transactions.map(tx => encodeMultiSendTx(tx.operation || 0, tx.to, tx.value || 0, tx.data))
    )
    const msInterface = new ethers.Interface(MULTISEND_ABI)
    return msInterface.encodeFunctionData('multiSend', [packed])
}

// ============================================================================
// Show current whitelist
// ============================================================================

async function showWhitelist(registryAddress, rpc) {
    const provider = new ethers.JsonRpcProvider(rpc)
    const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider)

    const tokens = await registry.getAllTokens()
    const owner = await registry.owner()

    console.log(`\nWhitelistRegistry: ${registryAddress}`)
    console.log(`Owner (Safe):      ${owner}`)
    console.log(`\nWhitelisted tokens (${tokens.length}):\n`)

    for (const token of tokens) {
        const symbol = await resolveSymbol(token, provider)
        console.log(`  ${symbol.padEnd(10)} ${token}`)
    }

    console.log()
}

// ============================================================================
// Argument parsing
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2)
    const result = {
        show: false,
        add: [],
        remove: null,
        setup: null,     // [registryAddr, helpersAddr]
        finalize: null,  // [helpersAddr, registryAddr]
        execute: false,
        rpc: process.env.BASE_RPC_URL || DEFAULT_RPC_URL,
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--show':
                result.show = true
                break
            case '--add':
                result.add.push(args[++i])
                break
            case '--remove':
                result.remove = args[++i]
                break
            case '--setup':
            case '--setup-batch':
                result.setup = [args[++i], args[++i]]
                break
            case '--finalize':
                result.finalize = [args[++i], args[++i]]
                break
            case '--execute':
            case '-x':
                result.execute = true
                break
            case '--rpc':
                result.rpc = args[++i]
                break
            case '--help':
                printHelp()
                process.exit(0)
        }
    }

    return result
}

function printHelp() {
    console.log(`
Token Whitelist Manager for Clawlett (V3 Registry)

Usage:
  node manage-whitelist.js [options]

Options:
  --show                  Show current whitelist from on-chain registry
  --add ADDR              Add a token (can be repeated for multiple)
  --remove ADDR           Remove a token
  --execute, -x           Sign and submit the Safe tx directly (no JSON upload)
  --setup REG HLP         Permission swap: allow new helpers, revoke old
  --finalize HLP REG      Update wallet.json with contract addresses
  --rpc URL               Base RPC URL (default: ${DEFAULT_RPC_URL})
  --help                  Show this help

Examples:
  # Add a token (one command, enter key, done):
  node manage-whitelist.js --add 0xTokenAddr --execute

  # Remove a token:
  node manage-whitelist.js --remove 0xTokenAddr --execute

  # Check current whitelist:
  node manage-whitelist.js --show

  # Permission swap (one-time):
  node manage-whitelist.js --setup 0xRegistry 0xHelpers --execute
`)
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const args = parseArgs()

    // ── Show ─────────────────────────────────────────────────────────────
    if (args.show) {
        const config = loadConfig()
        const registryAddress = config.contracts?.WhitelistRegistry
        if (!registryAddress) {
            console.error('Error: WhitelistRegistry not found in wallet.json.')
            process.exit(1)
        }
        await showWhitelist(registryAddress, args.rpc)
        return
    }

    // ── Finalize ─────────────────────────────────────────────────────────
    if (args.finalize) {
        const [helpersAddr, registryAddr] = args.finalize
        if (!ethers.isAddress(helpersAddr) || !ethers.isAddress(registryAddr)) {
            console.error('Error: Invalid address(es) provided to --finalize')
            process.exit(1)
        }

        const config = loadConfig()
        const oldHelpers = config.contracts?.ZodiacHelpers || '(not set)'
        config.contracts = config.contracts || {}
        config.contracts.ZodiacHelpers = ethers.getAddress(helpersAddr)
        config.contracts.WhitelistRegistry = ethers.getAddress(registryAddr)
        saveConfig(config)

        console.log('\nUpdated wallet.json:')
        console.log(`  ZodiacHelpers:     ${oldHelpers} -> ${ethers.getAddress(helpersAddr)}`)
        console.log(`  WhitelistRegistry: ${ethers.getAddress(registryAddr)}`)
        console.log('  Done.\n')
        return
    }

    // ── Setup (permission swap) ──────────────────────────────────────────
    if (args.setup) {
        const [registryAddr, helpersAddr] = args.setup
        if (!ethers.isAddress(registryAddr) || !ethers.isAddress(helpersAddr)) {
            console.error('Error: Invalid address(es)')
            process.exit(1)
        }

        const config = loadConfig()
        const rolesAddress = config.roles
        const currentHelpers = config.contracts?.ZodiacHelpers

        if (!rolesAddress || !currentHelpers) {
            console.error('Error: wallet.json missing roles or contracts.ZodiacHelpers')
            process.exit(1)
        }

        const rolesInterface = new ethers.Interface(ROLES_ABI)
        const transactions = [
            {
                to: rolesAddress,
                value: 0,
                data: rolesInterface.encodeFunctionData('scopeTarget', [ROLE_KEY, ethers.getAddress(helpersAddr)]),
            },
            {
                to: rolesAddress,
                value: 0,
                data: rolesInterface.encodeFunctionData('allowTarget', [ROLE_KEY, ethers.getAddress(helpersAddr), ExecutionOptions.Both]),
            },
            {
                to: rolesAddress,
                value: 0,
                data: rolesInterface.encodeFunctionData('revokeTarget', [ROLE_KEY, currentHelpers]),
            },
        ]

        console.log(`\n  Permission swap:`)
        console.log(`    Allow:  ${ethers.getAddress(helpersAddr)} (V3)`)
        console.log(`    Revoke: ${currentHelpers} (current)`)

        if (args.execute) {
            const multiSendData = encodeMultiSend(transactions)
            await execSafeTx(config.safe, MULTISEND, 0, multiSendData, 1, args.rpc) // operation=1 = delegatecall
            console.log(`\n  Done. Now run:`)
            console.log(`    node manage-whitelist.js --finalize ${ethers.getAddress(helpersAddr)} ${ethers.getAddress(registryAddr)}\n`)
        } else {
            const batch = {
                version: '1.0',
                chainId: '8453',
                createdAt: Math.floor(Date.now() / 1000),
                meta: { name: 'Permission Swap' },
                transactions: transactions.map(t => ({ ...t, value: '0' })),
            }
            const batchPath = path.join(__dirname, 'v3-setup-batch.json')
            fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2) + '\n')
            console.log(`\n  Batch JSON: ${batchPath}`)
            console.log(`  Upload to Safe web UI or re-run with --execute\n`)
        }
        return
    }

    // ── Add token(s) ─────────────────────────────────────────────────────
    if (args.add.length > 0) {
        const config = loadConfig()
        const registryAddress = config.contracts?.WhitelistRegistry
        if (!registryAddress) {
            console.error('Error: WhitelistRegistry not found in wallet.json.')
            process.exit(1)
        }

        const addresses = args.add.map(addr => {
            if (!ethers.isAddress(addr)) {
                console.error(`Error: Invalid address: ${addr}`)
                process.exit(1)
            }
            return ethers.getAddress(addr)
        })

        const provider = new ethers.JsonRpcProvider(args.rpc)
        const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider)

        for (const addr of addresses) {
            const already = await registry.isWhitelisted(addr)
            if (already) {
                const sym = await resolveSymbol(addr, provider)
                console.error(`Error: ${sym} (${addr}) is already whitelisted`)
                process.exit(1)
            }
        }

        for (const addr of addresses) {
            const sym = await resolveSymbol(addr, provider)
            console.log(`  + ${sym} (${addr})`)
        }

        const registryInterface = new ethers.Interface(REGISTRY_ABI)
        let callData
        if (addresses.length === 1) {
            callData = registryInterface.encodeFunctionData('addToken', [addresses[0]])
        } else {
            callData = registryInterface.encodeFunctionData('addTokens', [addresses])
        }

        if (args.execute) {
            // Direct call: Safe → registry.addToken() (operation=0 = call)
            await execSafeTx(config.safe, registryAddress, 0, callData, 0, args.rpc)
            console.log(`\n  Token(s) added to whitelist.\n`)
        } else {
            const batch = {
                version: '1.0',
                chainId: '8453',
                createdAt: Math.floor(Date.now() / 1000),
                meta: { name: `Add ${addresses.length} token(s)` },
                transactions: [{ to: registryAddress, value: '0', data: callData }],
            }
            const batchPath = path.join(__dirname, 'whitelist-add-batch.json')
            fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2) + '\n')
            console.log(`\n  Batch JSON: ${batchPath}`)
            console.log(`  Upload to Safe web UI or re-run with --execute\n`)
        }
        return
    }

    // ── Remove token ─────────────────────────────────────────────────────
    if (args.remove) {
        const config = loadConfig()
        const registryAddress = config.contracts?.WhitelistRegistry
        if (!registryAddress) {
            console.error('Error: WhitelistRegistry not found in wallet.json.')
            process.exit(1)
        }

        if (!ethers.isAddress(args.remove)) {
            console.error(`Error: Invalid address: ${args.remove}`)
            process.exit(1)
        }

        const address = ethers.getAddress(args.remove)
        const provider = new ethers.JsonRpcProvider(args.rpc)
        const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider)

        const isWl = await registry.isWhitelisted(address)
        if (!isWl) {
            console.error(`Error: ${address} is not currently whitelisted`)
            process.exit(1)
        }

        const sym = await resolveSymbol(address, provider)
        console.log(`  - ${sym} (${address})`)

        const registryInterface = new ethers.Interface(REGISTRY_ABI)
        const callData = registryInterface.encodeFunctionData('removeToken', [address])

        if (args.execute) {
            await execSafeTx(config.safe, registryAddress, 0, callData, 0, args.rpc)
            console.log(`\n  Token removed from whitelist.\n`)
        } else {
            const batch = {
                version: '1.0',
                chainId: '8453',
                createdAt: Math.floor(Date.now() / 1000),
                meta: { name: `Remove ${sym}` },
                transactions: [{ to: registryAddress, value: '0', data: callData }],
            }
            const batchPath = path.join(__dirname, 'whitelist-remove-batch.json')
            fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2) + '\n')
            console.log(`\n  Batch JSON: ${batchPath}`)
            console.log(`  Upload to Safe web UI or re-run with --execute\n`)
        }
        return
    }

    // ── No action ────────────────────────────────────────────────────────
    console.error('No action specified. Use --show, --add, --remove, --setup, or --finalize.')
    console.error('Run with --help for usage information.')
    process.exit(1)
}

main().catch(err => {
    console.error('\nError:', err.message)
    process.exit(1)
})
