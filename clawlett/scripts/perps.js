#!/usr/bin/env node

/**
 * Perpetuals trading on perps.eolas.fun via Orderly Network (Safe + Zodiac Roles)
 *
 * perps.eolas.fun is an Orderly Network perp DEX with broker ID "eolas".
 * The agent wallet acts as the Orderly account. USDC flows from the Safe
 * to Orderly via ZodiacHelpers approval + direct Vault.deposit() call.
 * Withdrawals land in the agent wallet and can be collected back to Safe.
 *
 * Subcommands:
 *   setup       One-time: generate API key, register with Orderly, configure Roles
 *   deposit     Deposit USDC from Safe to Orderly (agent's account)
 *   withdraw    Withdraw USDC from Orderly to agent wallet
 *   collect     Forward USDC from agent wallet to Safe (post-withdrawal)
 *   balance     Show Orderly balance + Safe USDC balance
 *   markets     List available perp markets with prices
 *   price       Get current price and stats for a symbol
 *   long        Open a long position
 *   short       Open a short position
 *   close       Close a position (reduce-only market order)
 *   positions   View open positions
 *   orders      View open orders
 *   cancel      Cancel an open order
 *
 * Usage:
 *   node perps.js setup
 *   node perps.js deposit --amount 100
 *   node perps.js long --symbol BTC --size 0.001
 *   node perps.js short --symbol ETH --size 0.1 --limit 1800
 *   node perps.js close --symbol BTC
 *   node perps.js positions
 */

import { ethers } from 'ethers'
import { generateKeyPairSync, createSign, createPrivateKey, createPublicKey } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_RPC_URL = 'https://mainnet.base.org'
const CHAIN_ID = 8453

// Orderly Network
const BROKER_ID = 'eolas'
const ORDERLY_API = 'https://api.orderly.org'

// Contracts (Base Mainnet)
const ORDERLY_VAULT   = '0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9'
const VERIFY_CONTRACT = '0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203'
const USDC_ADDRESS    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// EIP-712 domains
// Off-chain API signing (registration, add key, withdraw) uses the off-chain verifying contract
const ORDERLY_DOMAIN_OFFCHAIN = {
    name: 'Orderly',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
}
// On-chain signing uses the verify contract
const ORDERLY_DOMAIN = {
    name: 'Orderly',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: VERIFY_CONTRACT,
}

// EIP-712 types
const EIP712_TYPES = {
    Registration: [
        { name: 'brokerId',           type: 'string'  },
        { name: 'chainId',            type: 'uint256' },
        { name: 'timestamp',          type: 'uint64'  },
        { name: 'registrationNonce',  type: 'uint256' },
    ],
    AddOrderlyKey: [
        { name: 'brokerId',   type: 'string'  },
        { name: 'chainId',    type: 'uint256' },
        { name: 'orderlyKey', type: 'string'  },
        { name: 'scope',      type: 'string'  },
        { name: 'timestamp',  type: 'uint64'  },
        { name: 'expiration', type: 'uint64'  },
    ],
    Withdraw: [
        { name: 'brokerId',      type: 'string'  },
        { name: 'chainId',       type: 'uint256' },
        { name: 'receiver',      type: 'address' },
        { name: 'token',         type: 'string'  },
        { name: 'amount',        type: 'uint256' },
        { name: 'withdrawNonce', type: 'uint64'  },
        { name: 'timestamp',     type: 'uint64'  },
    ],
}

// ABIs
const ROLES_ABI = [
    'function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)',
]

const ZODIAC_HELPERS_ABI = [
    'function approveForFactory(address factory, address token, uint256 amount) external',
]

const VAULT_ABI = [
    'function deposit((bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) external payable',
    'function getDepositFee(address userAddress, (bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) external view returns (uint256)',
    'function depositFeeEnabled() external view returns (bool)',
]

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address, address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
]

const ROLES_CONFIG_ABI = [
    'function scopeTarget(bytes32 roleKey, address targetAddress)',
    'function allowTarget(bytes32 roleKey, address targetAddress, uint8 options)',
]

const SAFE_ABI = [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
    'function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool success)',
    'function isModuleEnabled(address module) view returns (bool)',
]

const MULTISEND_ABI = ['function multiSend(bytes transactions) payable']
const MULTISEND_ADDRESS = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761'

// Base58 alphabet
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// PKCS8 DER header for Ed25519 private key (prefix before 32-byte key seed)
const PKCS8_ED25519_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex')

// ============================================================================
// HELPERS
// ============================================================================

function base58Encode(buf) {
    let num = BigInt('0x' + buf.toString('hex') || '0')
    if (buf.length === 0) return ''
    let result = ''
    while (num > 0n) {
        result = B58_ALPHABET[Number(num % 58n)] + result
        num /= 58n
    }
    for (const byte of buf) {
        if (byte === 0) result = '1' + result
        else break
    }
    return result
}

function base64urlEncode(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function loadConfig(configDir) {
    const configPath = path.join(configDir, 'wallet.json')
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config not found: ${configPath}\nRun initialize.js first.`)
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function loadAgentWallet(configDir, rpcUrl) {
    const agentPkPath = path.join(configDir, 'agent.pk')
    if (!fs.existsSync(agentPkPath)) {
        throw new Error('Agent private key not found. Run initialize.js first.')
    }
    let pk = fs.readFileSync(agentPkPath, 'utf8').trim()
    if (!pk.startsWith('0x')) pk = '0x' + pk
    const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true })
    return new ethers.Wallet(pk, provider)
}

function formatUSDC(amount) {
    const num = Number(ethers.formatUnits(amount, 6))
    return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatEth(wei) {
    return `${parseFloat(ethers.formatEther(wei)).toFixed(6)} ETH`
}

function symbolToPerpSymbol(symbol) {
    symbol = symbol.toUpperCase()
    if (symbol.startsWith('PERP_')) return symbol
    if (symbol.endsWith('_USDC')) return `PERP_${symbol}`
    return `PERP_${symbol}_USDC`
}

// ============================================================================
// ORDERLY KEY MANAGEMENT
// ============================================================================

function generateOrderlyKey() {
    const { privateKey: privKey, publicKey: pubKey } = generateKeyPairSync('ed25519')
    const pubDer = pubKey.export({ type: 'spki', format: 'der' })
    const privDer = privKey.export({ type: 'pkcs8', format: 'der' })
    const rawPublicKey  = Buffer.from(pubDer).slice(-32)
    const rawPrivateKey = Buffer.from(privDer).slice(-32)
    return { privateKey: privKey, publicKey: pubKey, rawPublicKey, rawPrivateKey }
}

function saveOrderlyKey(configDir, keyPair) {
    const pkPath  = path.join(configDir, 'orderly.pk')
    const pubPath = path.join(configDir, 'orderly.pub')
    fs.writeFileSync(pkPath,  keyPair.rawPrivateKey.toString('hex'), { mode: 0o600 })
    fs.writeFileSync(pubPath, keyPair.rawPublicKey.toString('hex'))
}

function loadOrderlyKey(configDir) {
    const pkPath  = path.join(configDir, 'orderly.pk')
    const pubPath = path.join(configDir, 'orderly.pub')
    if (!fs.existsSync(pkPath)) {
        throw new Error('Orderly key not found. Run: node perps.js setup')
    }
    const rawPriv = Buffer.from(fs.readFileSync(pkPath, 'utf8').trim(), 'hex')
    const pkcs8   = Buffer.concat([PKCS8_ED25519_HEADER, rawPriv])
    const privateKey  = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    const publicKey   = createPublicKey(privateKey)
    const pubDer      = publicKey.export({ type: 'spki', format: 'der' })
    const rawPublicKey = Buffer.from(pubDer).slice(-32)

    // If pub file exists use it, otherwise derive
    if (fs.existsSync(pubPath)) {
        const savedPub = Buffer.from(fs.readFileSync(pubPath, 'utf8').trim(), 'hex')
        return { privateKey, publicKey, rawPublicKey: savedPub }
    }
    return { privateKey, publicKey, rawPublicKey }
}

function getOrderlyKeyStr(rawPublicKey) {
    return `ed25519:${base58Encode(rawPublicKey)}`
}

// ============================================================================
// ORDERLY API AUTHENTICATION
// ============================================================================

function signOrderlyRequest(privateKey, timestamp, method, urlPath, body = '') {
    const message = `${timestamp}${method.toUpperCase()}${urlPath}${body}`
    const sign = createSign('Ed25519')
    sign.update(Buffer.from(message))
    sign.end()
    const sig = sign.sign(privateKey)
    return base64urlEncode(sig)
}

function buildAuthHeaders(agentAddress, orderlyKey, privateKey, method, urlPath, body = '') {
    const timestamp = Date.now()
    const signature = signOrderlyRequest(privateKey, timestamp, method, urlPath, body)
    return {
        'orderly-account-id': `${BROKER_ID}|${agentAddress.toLowerCase()}`,
        'orderly-key':        getOrderlyKeyStr(orderlyKey.rawPublicKey),
        'orderly-timestamp':  String(timestamp),
        'orderly-signature':  signature,
        'Content-Type':       'application/json',
    }
}

async function orderlyFetch(method, urlPath, body, agentAddress, orderlyKey) {
    const bodyStr = body ? JSON.stringify(body) : ''
    const headers = buildAuthHeaders(agentAddress, orderlyKey, orderlyKey.privateKey, method, urlPath, bodyStr)
    const url = `${ORDERLY_API}${urlPath}`
    const opts = { method, headers }
    if (bodyStr) opts.body = bodyStr
    const res = await fetch(url, opts)
    const data = await res.json()
    if (!data.success) {
        throw new Error(`Orderly API error (${data.code || res.status}): ${data.message || JSON.stringify(data)}`)
    }
    return data
}

async function orderlyPublicFetch(urlPath) {
    const res = await fetch(`${ORDERLY_API}${urlPath}`)
    const data = await res.json()
    if (!data.success) {
        throw new Error(`Orderly API error: ${data.message || JSON.stringify(data)}`)
    }
    return data
}

// ============================================================================
// ORDERLY ACCOUNT HELPERS
// ============================================================================

function getAccountId(walletAddress) {
    const brokerHash = ethers.keccak256(ethers.toUtf8Bytes(BROKER_ID))
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [brokerHash, walletAddress])
    )
}

async function isAccountRegistered(agentAddress) {
    try {
        const res = await fetch(
            `${ORDERLY_API}/v1/get_account?address=${agentAddress.toLowerCase()}&broker_id=${BROKER_ID}&chain_type=EVM`
        )
        const data = await res.json()
        return data.success && data.data && !data.data.registration_nonce
    } catch {
        return false
    }
}

// ============================================================================
// DEPOSIT DATA HELPERS
// ============================================================================

function buildDepositData(agentAddress, usdcAmount) {
    const brokerHash = ethers.keccak256(ethers.toUtf8Bytes(BROKER_ID))
    const accountId  = getAccountId(agentAddress)
    const tokenHash  = ethers.keccak256(ethers.toUtf8Bytes('USDC'))
    return {
        accountId,
        brokerHash,
        tokenHash,
        tokenAmount: BigInt(usdcAmount),
    }
}

// ============================================================================
// ARG PARSING
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2)
    const result = {
        subcommand: null,
        symbol:     null,
        size:       null,
        limit:      null,   // limit price
        amount:     null,
        orderId:    null,
        all:        false,
        execute:    false,
        configDir:  process.env.WALLET_CONFIG_DIR || path.join(__dirname, '..', 'config'),
        rpc:        process.env.BASE_RPC_URL || DEFAULT_RPC_URL,
    }

    if (args.length > 0 && !args[0].startsWith('-')) result.subcommand = args[0]

    for (let i = result.subcommand ? 1 : 0; i < args.length; i++) {
        switch (args[i]) {
            case '--symbol':  case '-s': result.symbol  = args[++i]; break
            case '--size':              result.size    = args[++i]; break
            case '--limit':             result.limit   = args[++i]; break
            case '--amount': case '-a': result.amount  = args[++i]; break
            case '--order-id':          result.orderId = args[++i]; break
            case '--all':               result.all     = true;      break
            case '--execute':           result.execute = true;      break
            case '--config-dir': case '-c': result.configDir = args[++i]; break
            case '--rpc': case '-r':    result.rpc = args[++i]; break
            case '--help': case '-h':   printHelp(result.subcommand); process.exit(0)
            default:
                if (!args[i].startsWith('-') && result.subcommand && !result.symbol) {
                    result.symbol = args[i]
                }
        }
    }
    return result
}

function printHelp(sub) {
    const cmd = `node perps.js`
    if (!sub) {
        console.log(`
Usage: ${cmd} <subcommand> [options]

Perpetuals trading on perps.eolas.fun (Orderly Network, broker: ${BROKER_ID})

Subcommands:
  setup       One-time setup: register with Orderly + generate API key
  deposit     Deposit USDC from Safe into Orderly (requires --amount)
  withdraw    Request USDC withdrawal from Orderly to agent wallet
  collect     Forward USDC from agent wallet to Safe
  balance     Show Orderly balance + Safe USDC balance
  markets     List perp markets and prices
  price       Get price info for a market (e.g., BTC, ETH)
  long        Open long position
  short       Open short position
  close       Close position (reduce-only market order)
  positions   View open positions
  orders      View open orders
  cancel      Cancel an order (requires --order-id)

Common Options:
  --config-dir, -c  Config directory (default: ../config)
  --rpc, -r         RPC URL
  --help, -h        Show help

Examples:
  ${cmd} setup
  ${cmd} deposit --amount 100
  ${cmd} long --symbol BTC --size 0.001
  ${cmd} long --symbol ETH --size 0.1 --limit 1800
  ${cmd} short --symbol ETH --size 0.05
  ${cmd} close --symbol BTC
  ${cmd} positions
  ${cmd} withdraw --amount 50
  ${cmd} collect --all
`)
        return
    }
    const helpMap = {
        long:     `${cmd} long --symbol <SYM> --size <QTY> [--limit <PRICE>]\n\n  Open a long (buy) position. Without --limit uses market order.`,
        short:    `${cmd} short --symbol <SYM> --size <QTY> [--limit <PRICE>]\n\n  Open a short (sell) position. Without --limit uses market order.`,
        close:    `${cmd} close --symbol <SYM> [--size <QTY>]\n\n  Close a position. Omit --size to close the entire position.`,
        deposit:  `${cmd} deposit --amount <USDC>\n\n  Deposit USDC from Safe into Orderly.`,
        withdraw: `${cmd} withdraw --amount <USDC>\n\n  Request withdrawal from Orderly to agent wallet.`,
        collect:  `${cmd} collect [--amount <USDC>] [--all]\n\n  Forward USDC from agent wallet to Safe.`,
        balance:  `${cmd} balance\n\n  Show Orderly balance and Safe USDC balance.`,
        price:    `${cmd} price <SYMBOL>\n\n  Get current price and 24h stats.`,
        cancel:   `${cmd} cancel --order-id <ID>\n\n  Cancel a specific open order.`,
    }
    if (helpMap[sub]) console.log(`\nUsage: ${helpMap[sub]}\n`)
    else console.log(`\nUsage: ${cmd} ${sub} [options]\n`)
}

// ============================================================================
// ROLES HELPERS (for Vault direct call)
// ============================================================================

function loadRoles(config, agentWallet) {
    return new ethers.Contract(config.roles, ROLES_ABI, agentWallet)
}

async function callVaultDeposit(config, agentWallet, depositData, depositFee) {
    const roles = loadRoles(config, agentWallet)
    const zodiacHelpers = new ethers.Interface(ZODIAC_HELPERS_ABI)
    const vaultIface    = new ethers.Interface(VAULT_ABI)

    const usdcAmount = depositData.tokenAmount

    // Step 1: Approve USDC for Vault via ZodiacHelpers delegatecall
    console.log(`   Approving USDC for Vault...`)
    const approveData = zodiacHelpers.encodeFunctionData('approveForFactory', [
        ORDERLY_VAULT,
        USDC_ADDRESS,
        usdcAmount,
    ])
    const approveTx = await roles.execTransactionWithRole(
        config.contracts.ZodiacHelpers,
        0n,
        approveData,
        1, // delegatecall
        config.roleKey,
        true,
    )
    console.log(`   Approval tx: ${approveTx.hash}`)
    const approveReceipt = await approveTx.wait()
    if (approveReceipt.status !== 1) throw new Error('USDC approval failed')
    console.log('   Approved ✓')

    // Step 2: Call Vault.deposit() directly (Send)
    console.log(`   Depositing to Orderly Vault...`)
    const depositCalldata = vaultIface.encodeFunctionData('deposit', [depositData])
    const depositTx = await roles.execTransactionWithRole(
        ORDERLY_VAULT,
        depositFee,
        depositCalldata,
        0, // call (Send)
        config.roleKey,
        true,
    )
    console.log(`   Deposit tx: ${depositTx.hash}`)
    const depositReceipt = await depositTx.wait()
    if (depositReceipt.status !== 1) throw new Error('Vault deposit failed')
    console.log('   Deposited ✓')
    return depositReceipt
}

// ============================================================================
// SUBCOMMAND: SETUP
// ============================================================================

async function handleSetup(args) {
    const config    = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const provider  = agentWallet.provider
    const safeAddress = config.safe

    console.log('\n========================================')
    console.log('     Orderly Perps Setup (eolas)')
    console.log('========================================\n')
    console.log(`Agent:  ${agentWallet.address}`)
    console.log(`Safe:   ${safeAddress}`)
    console.log(`Broker: ${BROKER_ID}`)

    // --- Step 1: Generate (or load existing) Orderly Ed25519 keypair ---
    const pkPath = path.join(args.configDir, 'orderly.pk')
    let orderlyKey
    if (fs.existsSync(pkPath)) {
        console.log('\n[1/4] Loading existing Orderly keypair...')
        orderlyKey = loadOrderlyKey(args.configDir)
        console.log(`   Key: ${getOrderlyKeyStr(orderlyKey.rawPublicKey)}`)
    } else {
        console.log('\n[1/4] Generating Orderly Ed25519 keypair...')
        orderlyKey = generateOrderlyKey()
        saveOrderlyKey(args.configDir, orderlyKey)
        console.log(`   Key: ${getOrderlyKeyStr(orderlyKey.rawPublicKey)}`)
        console.log('   Saved to config/orderly.pk')
    }

    // --- Step 2: Register account with Orderly ---
    console.log('\n[2/4] Checking Orderly account...')
    const alreadyRegistered = await isAccountRegistered(agentWallet.address)

    if (!alreadyRegistered) {
        console.log('   Not registered — registering now...')

        // Get registration nonce
        const nonceRes = await fetch(
            `${ORDERLY_API}/v1/registration_nonce`,
            { headers: { 'orderly-account-id': `${BROKER_ID}|${agentWallet.address.toLowerCase()}` } }
        )
        const nonceData = await nonceRes.json()
        if (!nonceData.success) throw new Error(`Failed to get registration nonce: ${nonceData.message}`)
        const registrationNonce = BigInt(nonceData.data.registration_nonce)
        const timestamp = BigInt(Date.now())

        // Sign EIP-712 Registration message
        const registrationMsg = {
            brokerId:          BROKER_ID,
            chainId:           BigInt(CHAIN_ID),
            timestamp,
            registrationNonce,
        }
        const signature = await agentWallet.signTypedData(ORDERLY_DOMAIN_OFFCHAIN, { Registration: EIP712_TYPES.Registration }, registrationMsg)

        // POST to register
        const regRes = await fetch(`${ORDERLY_API}/v1/register_account`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                signature,
                userAddress:      agentWallet.address.toLowerCase(),
                verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
                message:          { ...registrationMsg, chainId: CHAIN_ID, timestamp: Number(timestamp), registrationNonce: Number(registrationNonce) },
            }),
        })
        const regData = await regRes.json()
        if (!regData.success) throw new Error(`Registration failed: ${regData.message}`)
        console.log('   Registered ✓')
    } else {
        console.log('   Already registered ✓')
    }

    // --- Step 3: Add Orderly API key ---
    console.log('\n[3/4] Adding Orderly API key...')
    const keyStr    = getOrderlyKeyStr(orderlyKey.rawPublicKey)
    const timestamp = BigInt(Date.now())
    const expiration = timestamp + BigInt(365 * 24 * 60 * 60 * 1000)

    const addKeyMsg = {
        brokerId:   BROKER_ID,
        chainId:    BigInt(CHAIN_ID),
        orderlyKey: keyStr,
        scope:      'trading',
        timestamp,
        expiration,
    }
    const keySig = await agentWallet.signTypedData(ORDERLY_DOMAIN_OFFCHAIN, { AddOrderlyKey: EIP712_TYPES.AddOrderlyKey }, addKeyMsg)

    const keyRes = await fetch(`${ORDERLY_API}/v1/orderly_key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            signature:         keySig,
            userAddress:       agentWallet.address.toLowerCase(),
            verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
            message: {
                ...addKeyMsg,
                chainId:    CHAIN_ID,
                timestamp:  Number(timestamp),
                expiration: Number(expiration),
            },
        }),
    })
    const keyData = await keyRes.json()
    if (!keyData.success) {
        // Key might already be registered — not fatal
        console.log(`   Note: ${keyData.message || 'key may already exist'}`)
    } else {
        console.log('   API key registered ✓')
    }

    // --- Step 4: Configure Zodiac Roles to allow Vault ---
    console.log('\n[4/4] Checking Roles configuration for Orderly Vault...')

    // Check if Vault is already allowed — try a dry-run read
    // We can't easily check allowTarget state directly, so we check config for a marker
    const vaultConfigured = config.orderlyVaultConfigured === true

    if (vaultConfigured) {
        console.log('   Vault already configured in Roles ✓')
    } else {
        console.log('   Configuring Roles to allow Vault calls...')
        console.log('   (This requires a Safe transaction through the Roles module)')

        try {
            // Build the MultiSend to add Vault to Roles
            const rolesIface     = new ethers.Interface(ROLES_CONFIG_ABI)
            const multiSendIface = new ethers.Interface(MULTISEND_ABI)
            const ExecutionOptions = { Send: 1 }

            const txns = [
                {
                    operation: 0,
                    to:   config.roles,
                    value: 0n,
                    data: rolesIface.encodeFunctionData('scopeTarget', [config.roleKey, ORDERLY_VAULT]),
                },
                {
                    operation: 0,
                    to:   config.roles,
                    value: 0n,
                    data: rolesIface.encodeFunctionData('allowTarget', [config.roleKey, ORDERLY_VAULT, ExecutionOptions.Send]),
                },
            ]

            // Encode MultiSend
            const encoded = ethers.concat(
                txns.map(tx => {
                    const dataBytes = ethers.getBytes(tx.data)
                    return ethers.solidityPacked(
                        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
                        [tx.operation, tx.to, tx.value, dataBytes.length, dataBytes]
                    )
                })
            )
            const multiSendCalldata = multiSendIface.encodeFunctionData('multiSend', [encoded])

            // Execute via Roles (agent calls Roles which calls Safe which executes MultiSend)
            // NOTE: Roles config changes must come FROM the Safe (as Roles owner).
            // The agent does NOT have Roles config permission — only the Safe owner does.
            // So we print the transaction for the human to execute.
            console.log('\n   ⚠️  MANUAL STEP REQUIRED')
            console.log('   The Orderly Vault must be added to Zodiac Roles by the Safe owner.')
            console.log('   Execute this transaction via the Safe web app (app.safe.global):')
            console.log(`\n   Safe:   ${safeAddress}`)
            console.log(`   To:     ${MULTISEND_ADDRESS}`)
            console.log(`   Value:  0`)
            console.log(`   Data:   ${multiSendCalldata}`)
            console.log(`   Op:     1 (DelegateCall)`)
            console.log('\n   Or re-run initialize.js to include this in the initial setup.')
            console.log('\n   After executing on Safe, update config/wallet.json:')
            console.log('   Add: "orderlyVaultConfigured": true')
        } catch (err) {
            console.log(`   Warning: Could not build Roles update: ${err.message}`)
        }
    }

    // Save orderly config into wallet.json
    const updatedConfig = { ...config, orderlySetup: true }
    fs.writeFileSync(path.join(args.configDir, 'wallet.json'), JSON.stringify(updatedConfig, null, 2))

    console.log('\n========================================')
    console.log('         Orderly Setup Complete!')
    console.log('========================================')
    console.log(`\nAccount ID: ${BROKER_ID}|${agentWallet.address.toLowerCase()}`)
    console.log(`Orderly Key: ${keyStr}`)
    console.log(`\nNext steps:`)
    console.log('  1. Ensure Vault is allowed in Roles (see Step 4 above)')
    console.log('  2. node perps.js deposit --amount 100  (USDC from Safe to Orderly)')
    console.log('  3. node perps.js long --symbol ETH --size 0.1')
    console.log('')
}

// ============================================================================
// SUBCOMMAND: DEPOSIT
// ============================================================================

async function handleDeposit(args) {
    if (!args.amount) {
        console.error('Error: --amount <USDC> is required')
        process.exit(1)
    }

    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const provider    = agentWallet.provider
    const safeAddress = config.safe

    // Check Safe USDC balance
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider)
    const safeUsdc = await usdc.balanceOf(safeAddress)
    const depositAmount = ethers.parseUnits(args.amount, 6) // USDC has 6 decimals

    console.log(`\nSafe USDC balance:  ${formatUSDC(safeUsdc)}`)
    console.log(`Deposit amount:     ${formatUSDC(depositAmount)}`)

    if (safeUsdc < depositAmount) {
        console.error(`\nInsufficient USDC in Safe. Need ${formatUSDC(depositAmount)}, have ${formatUSDC(safeUsdc)}`)
        process.exit(1)
    }

    // Build deposit data
    const depositData = buildDepositData(agentWallet.address, depositAmount)

    // Get deposit fee
    const vault       = new ethers.Contract(ORDERLY_VAULT, VAULT_ABI, provider)
    const depositFee  = await vault.getDepositFee(safeAddress, depositData)
    const safeEth     = await provider.getBalance(safeAddress)

    console.log(`Deposit fee (ETH):  ${formatEth(depositFee)}`)
    console.log(`Safe ETH balance:   ${formatEth(safeEth)}`)

    if (safeEth < depositFee) {
        console.error(`\nInsufficient ETH in Safe for deposit fee. Need ${formatEth(depositFee)}, have ${formatEth(safeEth)}`)
        process.exit(1)
    }

    console.log('\nDepositing USDC to Orderly...')
    const receipt = await callVaultDeposit(config, agentWallet, depositData, depositFee)

    console.log('\nDEPOSIT COMPLETE')
    console.log(`   Amount:  ${formatUSDC(depositAmount)}`)
    console.log(`   Account: ${BROKER_ID}|${agentWallet.address.toLowerCase()}`)
    console.log(`   Tx:      ${receipt.hash}`)
    console.log('\n   Note: Balance may take ~1 minute to appear on Orderly.')
}

// ============================================================================
// SUBCOMMAND: WITHDRAW
// ============================================================================

async function handleWithdraw(args) {
    if (!args.amount) {
        console.error('Error: --amount <USDC> is required')
        process.exit(1)
    }

    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const orderlyKey  = loadOrderlyKey(args.configDir)
    const agentAddr   = agentWallet.address

    // Check Orderly balance
    const balData = await orderlyFetch('GET', '/v1/client/holding', null, agentAddr, orderlyKey)
    const usdcHolding = balData.data?.holding?.find(h => h.token === 'USDC')
    const orderlyBalance = usdcHolding?.holding ?? 0

    const withdrawAmount = parseFloat(args.amount)
    console.log(`\nOrderly USDC balance: $${orderlyBalance.toFixed(2)}`)
    console.log(`Withdraw amount:      $${withdrawAmount.toFixed(2)}`)

    if (orderlyBalance < withdrawAmount) {
        console.error(`\nInsufficient Orderly balance. Need $${withdrawAmount}, have $${orderlyBalance.toFixed(2)}`)
        process.exit(1)
    }

    // Get withdrawal nonce
    const nonceData = await orderlyFetch('GET', '/v1/withdraw_nonce', null, agentAddr, orderlyKey)
    const withdrawNonce = BigInt(nonceData.data.withdraw_nonce)
    const timestamp     = BigInt(Date.now())

    // Amount in USDC base units (8 decimals for Orderly withdrawal, NOT 6)
    // Orderly uses 10^8 units internally for amounts in withdrawal EIP-712
    const amountUnits = BigInt(Math.round(withdrawAmount * 1e8))

    // Sign Withdraw EIP-712
    const withdrawMsg = {
        brokerId:      BROKER_ID,
        chainId:       BigInt(CHAIN_ID),
        receiver:      agentAddr,
        token:         'USDC',
        amount:        amountUnits,
        withdrawNonce,
        timestamp,
    }
    const signature = await agentWallet.signTypedData(ORDERLY_DOMAIN_OFFCHAIN, { Withdraw: EIP712_TYPES.Withdraw }, withdrawMsg)

    // Submit withdrawal request
    const body = {
        signature,
        userAddress:       agentAddr.toLowerCase(),
        verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
        message: {
            brokerId:      BROKER_ID,
            chainId:       CHAIN_ID,
            receiver:      agentAddr.toLowerCase(),
            token:         'USDC',
            amount:        Number(amountUnits),
            withdrawNonce: Number(withdrawNonce),
            timestamp:     Number(timestamp),
            chainType:     'EVM',
        },
        chainId: String(CHAIN_ID),
    }

    const bodyStr   = JSON.stringify(body)
    const headers   = buildAuthHeaders(agentAddr, orderlyKey, orderlyKey.privateKey, 'POST', '/v1/withdraw_request', bodyStr)
    const withdrawRes = await fetch(`${ORDERLY_API}/v1/withdraw_request`, { method: 'POST', headers, body: bodyStr })
    const withdrawData = await withdrawRes.json()
    if (!withdrawData.success) throw new Error(`Withdrawal failed: ${withdrawData.message}`)

    console.log('\nWITHDRAWAL REQUESTED')
    console.log(`   Amount:    $${withdrawAmount.toFixed(2)} USDC`)
    console.log(`   Receiver:  ${agentAddr}`)
    console.log(`   Orderly processes withdrawals periodically (~30 min).`)
    console.log(`   Run "node perps.js collect --all" once funds arrive.`)
}

// ============================================================================
// SUBCOMMAND: COLLECT
// ============================================================================

async function handleCollect(args) {
    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const safeAddress = config.safe
    const provider    = agentWallet.provider

    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, agentWallet)
    const agentBalance = await usdc.balanceOf(agentWallet.address)

    if (agentBalance === 0n) {
        console.log('\nNo USDC in agent wallet to collect.')
        return
    }

    let transferAmount
    if (args.all) {
        transferAmount = agentBalance
    } else if (args.amount) {
        transferAmount = ethers.parseUnits(args.amount, 6)
        if (agentBalance < transferAmount) {
            console.error(`\nInsufficient USDC. Need ${formatUSDC(transferAmount)}, have ${formatUSDC(agentBalance)}`)
            process.exit(1)
        }
    } else {
        console.error('Error: --amount <USDC> or --all required')
        process.exit(1)
    }

    console.log(`\nAgent USDC balance: ${formatUSDC(agentBalance)}`)
    console.log(`Sending to Safe:    ${formatUSDC(transferAmount)}`)
    console.log(`Safe:               ${safeAddress}`)

    const tx = await usdc.transfer(safeAddress, transferAmount)
    console.log(`\nTransaction: ${tx.hash}`)
    const receipt = await tx.wait()
    if (receipt.status !== 1) throw new Error('Transfer failed')

    console.log('\nCOLLECT COMPLETE')
    console.log(`   Transferred: ${formatUSDC(transferAmount)} → Safe`)
    console.log(`   Tx: ${receipt.hash}`)
}

// ============================================================================
// SUBCOMMAND: BALANCE
// ============================================================================

async function handleBalance(args) {
    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const orderlyKey  = loadOrderlyKey(args.configDir)
    const provider    = agentWallet.provider
    const safeAddress = config.safe

    // Safe balances
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider)
    const safeUsdc = await usdc.balanceOf(safeAddress)
    const safeEth  = await provider.getBalance(safeAddress)
    const agentEth = await provider.getBalance(agentWallet.address)
    const agentUsdc = await usdc.balanceOf(agentWallet.address)

    console.log('\n=== Safe ===')
    console.log(`  ETH:  ${formatEth(safeEth)}`)
    console.log(`  USDC: ${formatUSDC(safeUsdc)}`)

    console.log('\n=== Agent Wallet ===')
    console.log(`  ETH:  ${formatEth(agentEth)}`)
    console.log(`  USDC: ${formatUSDC(agentUsdc)} (collected: send to Safe with "collect --all")`)

    // Orderly balance
    console.log('\n=== Orderly (perps.eolas.fun) ===')
    try {
        const balData = await orderlyFetch('GET', '/v1/client/holding', null, agentWallet.address, orderlyKey)
        const holdings = balData.data?.holding ?? []
        for (const h of holdings) {
            if (h.holding !== 0 || h.frozen !== 0) {
                console.log(`  ${h.token}: ${h.holding.toFixed(4)} (frozen: ${h.frozen.toFixed(4)})`)
            }
        }
        if (holdings.filter(h => h.holding !== 0).length === 0) {
            console.log('  (empty — deposit USDC to start trading)')
        }
    } catch (err) {
        console.log(`  (unavailable: ${err.message})`)
    }

    // Open positions summary
    try {
        const posData = await orderlyFetch('GET', '/v1/positions', null, agentWallet.address, orderlyKey)
        const positions = posData.data?.rows ?? []
        if (positions.length > 0) {
            console.log('\n=== Open Positions ===')
            for (const p of positions) {
                const pnl   = p.unrealized_pnl
                const side  = p.position_qty > 0 ? 'LONG' : 'SHORT'
                const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`
                console.log(`  ${p.symbol.replace('PERP_','').replace('_USDC','')} ${side} ${Math.abs(p.position_qty)} @ $${p.average_open_price?.toFixed(2)} (PnL: ${pnlStr})`)
            }
        }
    } catch {}
}

// ============================================================================
// SUBCOMMAND: MARKETS
// ============================================================================

async function handleMarkets(args) {
    const data = await orderlyPublicFetch('/v1/public/futures')
    const rows = data.data?.rows ?? []

    console.log(`\n${'Symbol'.padEnd(20)} ${'Price'.padEnd(14)} ${'24h Change'.padEnd(12)} ${'24h Volume'.padEnd(16)} ${'Open Interest'}`)
    console.log('-'.repeat(80))

    const sorted = rows.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))

    for (const m of sorted.slice(0, 30)) {
        const sym    = m.symbol.replace('PERP_','').replace('_USDC','').padEnd(20)
        const price  = m.mark_price != null ? `$${Number(m.mark_price).toFixed(4)}`.padEnd(14) : 'N/A'.padEnd(14)
        const change = m.change != null ? `${m.change >= 0 ? '+' : ''}${(m.change * 100).toFixed(2)}%`.padEnd(12) : 'N/A'.padEnd(12)
        const vol    = m.volume != null ? `$${(m.volume/1e6).toFixed(1)}M`.padEnd(16) : 'N/A'.padEnd(16)
        const oi     = m.open_interest != null ? `$${(m.open_interest/1e6).toFixed(1)}M` : 'N/A'
        console.log(`${sym} ${price} ${change} ${vol} ${oi}`)
    }

    console.log(`\n${rows.length} total markets. Use "node perps.js price BTC" for details.`)
}

// ============================================================================
// SUBCOMMAND: PRICE
// ============================================================================

async function handlePrice(args) {
    if (!args.symbol) {
        console.error('Error: symbol required (e.g., node perps.js price BTC)')
        process.exit(1)
    }
    const perpSym = symbolToPerpSymbol(args.symbol)
    const data = await orderlyPublicFetch(`/v1/public/futures/${perpSym}`)
    const m = data.data

    console.log(`\n=== ${perpSym} ===`)
    console.log(`  Mark Price:     $${m.mark_price ?? 'N/A'}`)
    console.log(`  Index Price:    $${m.index_price ?? 'N/A'}`)
    console.log(`  24h Change:     ${m.change != null ? (m.change * 100).toFixed(2) + '%' : 'N/A'}`)
    console.log(`  24h Volume:     $${m.volume != null ? (m.volume/1e6).toFixed(2) + 'M' : 'N/A'}`)
    console.log(`  Open Interest:  $${m.open_interest != null ? (m.open_interest/1e6).toFixed(2) + 'M' : 'N/A'}`)
    console.log(`  Funding Rate:   ${m.est_funding_rate != null ? (m.est_funding_rate * 100).toFixed(6) + '% (est)' : 'N/A'}`)
    console.log(`  Max Leverage:   ${m.base_max_leverage ?? 'N/A'}x`)
    console.log(`  Min Order Qty:  ${m.base_min ?? 'N/A'} (tick: ${m.base_tick ?? 'N/A'})`)
}

// ============================================================================
// SUBCOMMAND: LONG / SHORT
// ============================================================================

async function handleOrder(args, side) {
    if (!args.symbol) {
        console.error(`Error: --symbol is required`)
        process.exit(1)
    }
    if (!args.size) {
        console.error('Error: --size <quantity> is required')
        process.exit(1)
    }

    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const orderlyKey  = loadOrderlyKey(args.configDir)
    const perpSym     = symbolToPerpSymbol(args.symbol)
    const orderSide   = side === 'long' ? 'BUY' : 'SELL'
    const orderType   = args.limit ? 'LIMIT' : 'MARKET'

    // Fetch current price for context
    let markPrice = null
    try {
        const priceData = await orderlyPublicFetch(`/v1/public/futures/${perpSym}`)
        markPrice = priceData.data?.mark_price
    } catch {}

    console.log(`\n${orderSide} ${perpSym}`)
    console.log(`  Type:     ${orderType}`)
    console.log(`  Size:     ${args.size}`)
    if (args.limit) console.log(`  Price:    $${args.limit}`)
    if (markPrice)  console.log(`  Mark:     $${markPrice}`)

    const orderBody = {
        symbol:         perpSym,
        order_type:     orderType,
        order_quantity: parseFloat(args.size),
        side:           orderSide,
        broker_id:      BROKER_ID,
    }
    if (args.limit) orderBody.order_price = parseFloat(args.limit)

    console.log(`\nPlacing order...`)
    const result = await orderlyFetch('POST', '/v1/order', orderBody, agentWallet.address, orderlyKey)

    console.log('\nORDER PLACED')
    console.log(`   Order ID:  ${result.data?.order_id}`)
    console.log(`   Symbol:    ${perpSym}`)
    console.log(`   Side:      ${orderSide}`)
    console.log(`   Type:      ${orderType}`)
    console.log(`   Size:      ${args.size}`)
    if (args.limit) console.log(`   Price:     $${args.limit}`)
    console.log(`   Status:    ${result.data?.status ?? 'PENDING'}`)
}

// ============================================================================
// SUBCOMMAND: CLOSE
// ============================================================================

async function handleClose(args) {
    if (!args.symbol) {
        console.error('Error: --symbol is required')
        process.exit(1)
    }

    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const orderlyKey  = loadOrderlyKey(args.configDir)
    const perpSym     = symbolToPerpSymbol(args.symbol)

    // Fetch open position for this symbol
    const posData  = await orderlyFetch('GET', '/v1/positions', null, agentWallet.address, orderlyKey)
    const positions = posData.data?.rows ?? []
    const position  = positions.find(p => p.symbol === perpSym)

    if (!position || position.position_qty === 0) {
        console.log(`\nNo open position for ${perpSym}`)
        return
    }

    const qty  = Math.abs(position.position_qty)
    const side = position.position_qty > 0 ? 'SELL' : 'BUY' // opposite to close

    let closeQty = args.size ? parseFloat(args.size) : qty

    console.log(`\nClosing ${perpSym} position`)
    console.log(`  Current:   ${position.position_qty > 0 ? 'LONG' : 'SHORT'} ${qty}`)
    console.log(`  Close qty: ${closeQty}`)
    console.log(`  Side:      ${side} (reduce-only)`)

    const orderBody = {
        symbol:         perpSym,
        order_type:     'MARKET',
        order_quantity: closeQty,
        side,
        reduce_only:    true,
        broker_id:      BROKER_ID,
    }

    const result = await orderlyFetch('POST', '/v1/order', orderBody, agentWallet.address, orderlyKey)

    console.log('\nCLOSE ORDER PLACED')
    console.log(`   Order ID: ${result.data?.order_id}`)
    console.log(`   Symbol:   ${perpSym}`)
    console.log(`   Close qty: ${closeQty}`)
    console.log(`   Status:   ${result.data?.status ?? 'PENDING'}`)
}

// ============================================================================
// SUBCOMMAND: POSITIONS
// ============================================================================

async function handlePositions(args) {
    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const orderlyKey  = loadOrderlyKey(args.configDir)

    const posData  = await orderlyFetch('GET', '/v1/positions', null, agentWallet.address, orderlyKey)
    const positions = (posData.data?.rows ?? []).filter(p => p.position_qty !== 0)

    if (positions.length === 0) {
        console.log('\nNo open positions.')
        return
    }

    console.log(`\n${'Symbol'.padEnd(20)} ${'Side'.padEnd(8)} ${'Size'.padEnd(12)} ${'Entry'.padEnd(14)} ${'Mark'.padEnd(14)} ${'Unr. PnL'.padEnd(12)} ${'Liq. Price'}`)
    console.log('-'.repeat(95))

    for (const p of positions) {
        const sym  = p.symbol.replace('PERP_','').replace('_USDC','').padEnd(20)
        const side = (p.position_qty > 0 ? 'LONG' : 'SHORT').padEnd(8)
        const size = String(Math.abs(p.position_qty)).padEnd(12)
        const entry = (p.average_open_price != null ? `$${p.average_open_price.toFixed(4)}` : 'N/A').padEnd(14)
        const mark  = (p.mark_price != null ? `$${p.mark_price.toFixed(4)}` : 'N/A').padEnd(14)
        const pnl   = p.unrealized_pnl
        const pnlStr = (pnl != null ? (pnl >= 0 ? '+$' + pnl.toFixed(2) : '-$' + Math.abs(pnl).toFixed(2)) : 'N/A').padEnd(12)
        const liq   = p.est_liq_price != null ? `$${p.est_liq_price.toFixed(4)}` : 'N/A'
        console.log(`${sym} ${side} ${size} ${entry} ${mark} ${pnlStr} ${liq}`)
    }

    const totalPnl = positions.reduce((s, p) => s + (p.unrealized_pnl ?? 0), 0)
    console.log(`\nTotal Unrealized PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`)
}

// ============================================================================
// SUBCOMMAND: ORDERS
// ============================================================================

async function handleOrders(args) {
    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const orderlyKey  = loadOrderlyKey(args.configDir)

    const ordersData = await orderlyFetch('GET', '/v1/orders?status=INCOMPLETE', null, agentWallet.address, orderlyKey)
    const orders = ordersData.data?.rows ?? []

    if (orders.length === 0) {
        console.log('\nNo open orders.')
        return
    }

    console.log(`\n${'ID'.padEnd(14)} ${'Symbol'.padEnd(20)} ${'Side'.padEnd(8)} ${'Type'.padEnd(10)} ${'Qty'.padEnd(10)} ${'Price'.padEnd(14)} ${'Filled'.padEnd(10)} Status`)
    console.log('-'.repeat(90))

    for (const o of orders) {
        const id     = String(o.order_id).padEnd(14)
        const sym    = (o.symbol || '').replace('PERP_','').replace('_USDC','').padEnd(20)
        const side   = (o.side || '').padEnd(8)
        const type   = (o.type || '').padEnd(10)
        const qty    = String(o.quantity || o.order_quantity || '').padEnd(10)
        const price  = (o.price ? `$${o.price}` : 'MARKET').padEnd(14)
        const filled = String(o.executed || 0).padEnd(10)
        const status = o.status || ''
        console.log(`${id} ${sym} ${side} ${type} ${qty} ${price} ${filled} ${status}`)
    }

    console.log(`\n${orders.length} open orders. Cancel with: node perps.js cancel --order-id <ID>`)
}

// ============================================================================
// SUBCOMMAND: CANCEL
// ============================================================================

async function handleCancel(args) {
    if (!args.orderId && !args.symbol) {
        console.error('Error: --order-id <ID> or --symbol <SYM> required')
        process.exit(1)
    }

    const config      = loadConfig(args.configDir)
    const agentWallet = loadAgentWallet(args.configDir, args.rpc)
    const orderlyKey  = loadOrderlyKey(args.configDir)

    if (args.orderId) {
        // Cancel single order
        const sym = args.symbol ? `&symbol=${symbolToPerpSymbol(args.symbol)}` : ''
        const path = `/v1/order?order_id=${args.orderId}${sym}`
        const headers = buildAuthHeaders(agentWallet.address, orderlyKey, orderlyKey.privateKey, 'DELETE', path)
        const res  = await fetch(`${ORDERLY_API}${path}`, { method: 'DELETE', headers })
        const data = await res.json()
        if (!data.success) throw new Error(`Cancel failed: ${data.message}`)
        console.log(`\nOrder ${args.orderId} cancelled ✓`)
    } else {
        // Cancel all orders for symbol
        const perpSym = symbolToPerpSymbol(args.symbol)
        const path    = `/v1/orders?symbol=${perpSym}`
        const headers = buildAuthHeaders(agentWallet.address, orderlyKey, orderlyKey.privateKey, 'DELETE', path)
        const res     = await fetch(`${ORDERLY_API}${path}`, { method: 'DELETE', headers })
        const data    = await res.json()
        if (!data.success) throw new Error(`Cancel all failed: ${data.message}`)
        const count = data.data?.records ?? 0
        console.log(`\nCancelled ${count} orders for ${perpSym} ✓`)
    }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const args = parseArgs()

    if (!args.subcommand) {
        printHelp()
        process.exit(0)
    }

    switch (args.subcommand) {
        case 'setup':     await handleSetup(args);          break
        case 'deposit':   await handleDeposit(args);        break
        case 'withdraw':  await handleWithdraw(args);       break
        case 'collect':   await handleCollect(args);        break
        case 'balance':   await handleBalance(args);        break
        case 'markets':   await handleMarkets(args);        break
        case 'price':     await handlePrice(args);          break
        case 'long':      await handleOrder(args, 'long');  break
        case 'short':     await handleOrder(args, 'short'); break
        case 'close':     await handleClose(args);          break
        case 'positions': await handlePositions(args);      break
        case 'orders':    await handleOrders(args);         break
        case 'cancel':    await handleCancel(args);         break
        default:
            console.error(`Unknown subcommand: ${args.subcommand}`)
            printHelp()
            process.exit(1)
    }
}

main().catch(err => {
    console.error(`\nError: ${err.message}`)
    if (process.env.DEBUG) console.error(err.stack)
    process.exit(1)
})
