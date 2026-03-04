// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ============================================================================
// Interfaces (must be top-level in Solidity 0.8.x)
// ============================================================================

interface IWETH3 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface ICowSettlement3 {
    function setPreSignature(bytes calldata orderUid, bool signed) external;
    function domainSeparator() external view returns (bytes32);
}

interface IAeroRouter3 {
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;
}

interface IWhitelistRegistry {
    function isWhitelisted(address token) external view returns (bool);
}

/// @title ZodiacHelpersV3
/// @notice Helper contract for Clawlett AI agent wallets. Runs via delegatecall from a Gnosis Safe.
///         Provides MEV-protected swaps via CoW Protocol, Aerodrome swaps, ETH wrapping, and
///         Trenches token operations.
///
/// @dev V3 UPGRADE: Uses an external WhitelistRegistry instead of a hardcoded token list.
///      The registry address is stored as `immutable` (in bytecode, not storage), so it
///      doesn't collide with the Safe's storage during delegatecall. The registry call is
///      a normal external STATICCALL, reading from the registry's own storage.
///
///      This means adding/removing tokens only requires a Safe transaction calling
///      registry.addToken() or registry.removeToken() — NO contract redeployment needed.
///
///      This contract is designed to be called via DELEGATECALL from a Gnosis Safe through
///      the Zodiac Roles Modifier. In this context:
///        - address(this) = the Safe address
///        - msg.sender = the Safe address (Roles calls Safe, Safe delegatecalls here)
///        - Storage operations use the Safe's storage (not this contract's)
contract ZodiacHelpersV3 {
    using SafeERC20 for IERC20;

    // ========================================================================
    // Immutables (stored in bytecode — safe for delegatecall)
    // ========================================================================

    /// @dev The WhitelistRegistry contract address. Set once at deployment.
    ///      Immutable = stored in deployed bytecode, NOT in storage.
    ///      This is critical for delegatecall safety.
    address public immutable WHITELIST_REGISTRY;

    // ========================================================================
    // Constants (matching original ZodiacHelpers)
    // ========================================================================

    address public constant WETH_ADDR = 0x4200000000000000000000000000000000000006;
    address public constant COW_SETTLEMENT_ADDR = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address public constant VAULT_RELAYER_ADDR = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    address public constant AERO_ROUTER_ADDR = 0x6Df1c91424F79E40E33B1A48F0687B666bE71075;
    address public constant FACTORY1 = 0x68035FbC9c47aCc89140705806E2C183F35B3A5a;
    address public constant FACTORY2 = 0x1f17a9Fa19C7b153CFe307133eCBb806A5F9d34B;

    /// @dev GPv2 order type hash for EIP-712 signing
    bytes32 public constant GPV2_ORDER_TYPE_HASH =
        0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;

    // ========================================================================
    // Custom Errors
    // ========================================================================

    error TokenNotWhitelisted();
    error ReceiverNotSelf();
    error FactoryNotWhitelisted();
    error InvalidCommand(uint256 index, uint8 command);
    error InvalidRecipient(uint256 index, address recipient);

    // ========================================================================
    // Structs
    // ========================================================================

    /// @dev CoW Protocol GPv2Order struct — must match the ABI in swap.js
    struct Order {
        address sellToken;
        address buyToken;
        address receiver;
        uint256 sellAmount;
        uint256 buyAmount;
        uint32 validTo;
        bytes32 appData;
        uint256 feeAmount;
        bytes32 kind;
        bool partiallyFillable;
        bytes32 sellTokenBalance;
        bytes32 buyTokenBalance;
    }

    // ========================================================================
    // Constructor
    // ========================================================================

    /// @param _registry The WhitelistRegistry contract address
    constructor(address _registry) {
        require(_registry != address(0), "Zero registry");
        WHITELIST_REGISTRY = _registry;
    }

    // ========================================================================
    // View / Getter functions (match original selectors)
    // ========================================================================

    /// @dev Selector: 0xad5c4648
    function WETH() external pure returns (address) {
        return WETH_ADDR;
    }

    /// @dev Selector: 0x74320225
    function COW_SETTLEMENT() external pure returns (address) {
        return COW_SETTLEMENT_ADDR;
    }

    /// @dev Selector: 0x1a5c49d2 — VAULT_RELAYER getter
    function VAULT_RELAYER() external pure returns (address) {
        return VAULT_RELAYER_ADDR;
    }

    /// @dev Selector: 0x3b9deaae
    function AERO_ROUTER() external pure returns (address) {
        return AERO_ROUTER_ADDR;
    }

    /// @dev Selector: 0x896e5af7 — Factory 1 getter
    function FACTORY_1() external pure returns (address) {
        return FACTORY1;
    }

    /// @dev Selector: 0xf1cec6fb — Factory 2 getter
    function FACTORY_2() external pure returns (address) {
        return FACTORY2;
    }

    // ========================================================================
    // Core: ETH Wrapping
    // ========================================================================

    /// @notice Wrap ETH to WETH. Called via delegatecall from Safe.
    /// @dev Selector: 0x1c58db4f
    function wrapETH(uint256 amount) external {
        IWETH3(WETH_ADDR).deposit{value: amount}();
    }

    /// @notice Unwrap WETH to ETH. Called via delegatecall from Safe.
    /// @dev Selector: 0xf018a8c1
    function unwrapWETH(uint256 amount) external {
        IWETH3(WETH_ADDR).withdraw(amount);
    }

    // ========================================================================
    // Core: Approvals
    // ========================================================================

    /// @notice Approve tokens for the Aerodrome Router.
    /// @dev Selector: 0xf239b05c
    function approveForRouter(address token, uint256 amount) external {
        _safeApprove(token, AERO_ROUTER_ADDR, amount);
    }

    /// @notice Approve tokens for a whitelisted factory (Trenches).
    /// @dev Selector: 0xe4bd884d
    function approveForFactory(address factory, address token, uint256 amount) external {
        if (factory != FACTORY1 && factory != FACTORY2) {
            revert FactoryNotWhitelisted();
        }
        _safeApprove(token, factory, amount);
    }

    // ========================================================================
    // Core: CoW Protocol Presign (V3 — external registry whitelist)
    // ========================================================================

    /// @notice Presign a CoW Protocol order on behalf of the Safe.
    ///         Validates the order, approves sellToken to VaultRelayer, and calls
    ///         setPreSignature on the CoW Settlement contract.
    ///
    /// @dev SECURITY: This function enforces TWO critical checks:
    ///      1. order.buyToken must be whitelisted in the external WhitelistRegistry
    ///      2. order.receiver must be address(this) (= Safe, since delegatecall)
    ///
    /// @dev Selector: 0xbb2b5230
    function cowPreSign(Order calldata order, bytes calldata orderUid) external {
        // ---- buyToken whitelist check via external registry ----
        if (!_isWhitelisted(order.buyToken)) {
            revert TokenNotWhitelisted();
        }

        // Get domain separator from CoW Settlement
        bytes32 domainSeparator = ICowSettlement3(COW_SETTLEMENT_ADDR).domainSeparator();

        // Hash the order struct using GPv2 EIP-712 type hash
        bytes32 orderStructHash = keccak256(
            abi.encode(
                GPV2_ORDER_TYPE_HASH,
                order.sellToken,
                order.buyToken,
                order.receiver,
                order.sellAmount,
                order.buyAmount,
                order.validTo,
                order.appData,
                order.feeAmount,
                order.kind,
                order.partiallyFillable,
                order.sellTokenBalance,
                order.buyTokenBalance
            )
        );

        // Compute the EIP-712 digest
        bytes32 orderDigest = keccak256(
            abi.encodePacked(
                bytes2(0x1901),
                domainSeparator,
                orderStructHash
            )
        );

        // Validate orderUid: must be 56 bytes = orderDigest(32) + owner(20) + validTo(4)
        require(orderUid.length == 56, "GPv2: invalid uid");

        // Verify orderUid matches: keccak256(orderDigest ++ address(this) ++ validTo)
        bytes32 expectedUidHash = keccak256(
            abi.encodePacked(orderDigest, address(this), order.validTo)
        );
        bytes32 actualUidHash = keccak256(orderUid);
        require(expectedUidHash == actualUidHash, "GPv2: invalid uid");

        // Enforce receiver = address(this) (= Safe in delegatecall context)
        address receiver = order.receiver;
        if (receiver == address(0)) {
            receiver = address(this);
        }
        if (receiver != address(this)) {
            revert ReceiverNotSelf();
        }

        // Approve sellToken to VaultRelayer for sellAmount + feeAmount
        uint256 approveAmount = order.sellAmount + order.feeAmount;
        _safeApprove(order.sellToken, VAULT_RELAYER_ADDR, approveAmount);

        // Presign the order on the CoW Settlement contract
        ICowSettlement3(COW_SETTLEMENT_ADDR).setPreSignature(orderUid, true);
    }

    // ========================================================================
    // Core: Aerodrome Execute (V3: output token whitelist validation)
    // ========================================================================

    /// @notice Execute commands on the Aerodrome Universal Router.
    ///         Validates command types, recipient addresses, AND output tokens.
    ///
    /// @dev Allowed commands: 0 (V3_SWAP_EXACT_IN), 1 (V3_SWAP_EXACT_OUT),
    ///      8 (V2_SWAP_EXACT_IN), 9 (V2_SWAP_EXACT_OUT), 11 (WRAP_ETH), 12 (UNWRAP_WETH)
    ///      Recipient must be 1 (MSG_SENDER=Safe) or 2 (ADDRESS_THIS=Router).
    ///      For swap commands (0,1,8,9), the output token must be whitelisted.
    ///
    /// @dev Selector: 0xd4c2973b
    function aeroExecute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline,
        uint256 value
    ) external {
        uint256 numCommands = commands.length;

        for (uint256 i = 0; i < numCommands; i++) {
            uint8 command = uint8(commands[i]) & 0x3f;

            // Validate command type
            if (
                command != 0 && command != 1 &&
                command != 8 && command != 9 &&
                command != 11 && command != 12
            ) {
                revert InvalidCommand(i, command);
            }

            // Validate recipient for swap commands (first field of input after decoding)
            // The first 32 bytes of each input encode the recipient address
            if (inputs[i].length >= 32) {
                address recipient = address(uint160(uint256(bytes32(inputs[i][:32]))));
                if (recipient != address(1) && recipient != address(2)) {
                    revert InvalidRecipient(i, recipient);
                }
            }

            // Validate output token for swap commands (skip WRAP_ETH/UNWRAP_WETH)
            if (command <= 1 || command == 8 || command == 9) {
                address outputToken = _extractOutputToken(inputs[i], command);
                if (!_isWhitelisted(outputToken)) {
                    revert TokenNotWhitelisted();
                }
            }
        }

        // Forward to Aerodrome Router
        IAeroRouter3(AERO_ROUTER_ADDR).execute{value: value}(commands, inputs, deadline);
    }

    /// @dev Aerodrome Universal Router V2 swap route (from, to, stable).
    ///      Note: the regular Aerodrome Router adds a factory field, but the
    ///      Universal Router uses this 3-field version.
    struct Route {
        address from;
        address to;
        bool stable;
    }

    /// @dev Extract the output token from an Aerodrome swap command's input data.
    /// @param input The ABI-encoded input for a single command.
    /// @param command The command type (0, 1, 8, or 9).
    function _extractOutputToken(bytes calldata input, uint8 command) internal pure returns (address) {
        if (command == 0) {
            // V3_SWAP_EXACT_IN: (address, uint256, uint256, bytes path, bool)
            // path = tokenIn(20) + tickSpacing(3) + ... + tokenOut(20)
            // Output token = last 20 bytes of path
            (, , , bytes memory path, ) = abi.decode(input, (address, uint256, uint256, bytes, bool));
            require(path.length >= 43, "V3: invalid path");
            address token;
            uint256 offset = path.length - 20;
            assembly {
                token := shr(96, mload(add(add(path, 32), offset)))
            }
            return token;
        } else if (command == 1) {
            // V3_SWAP_EXACT_OUT: same encoding but path is reversed
            // Output token = first 20 bytes of path
            (, , , bytes memory path, ) = abi.decode(input, (address, uint256, uint256, bytes, bool));
            require(path.length >= 43, "V3: invalid path");
            address token;
            assembly {
                token := shr(96, mload(add(path, 32)))
            }
            return token;
        } else {
            // V2_SWAP_EXACT_IN (8) or V2_SWAP_EXACT_OUT (9)
            // (address, uint256, uint256, Route[], bool)
            // Output token = last route's `to` field
            (, , , Route[] memory routes, ) = abi.decode(input, (address, uint256, uint256, Route[], bool));
            require(routes.length >= 1, "V2: empty routes");
            return routes[routes.length - 1].to;
        }
    }

    // ========================================================================
    // Trenches: Factory Operations (unchanged from original)
    // ========================================================================

    /// @notice Create a token via a whitelisted Trenches factory.
    /// @dev Selector: 0x64847e37
    function trenchesCreate(
        address factory,
        bytes calldata createData,
        uint256 value
    ) external {
        if (factory != FACTORY1 && factory != FACTORY2) {
            revert FactoryNotWhitelisted();
        }
        (bool success,) = factory.call{value: value}(
            abi.encodePacked(bytes4(0xdd3034c1), createData)
        );
        require(success, "Trenches create failed");
    }

    /// @notice Buy tokens via a whitelisted Trenches factory.
    /// @dev Selector: 0xf098b29e
    function trenchesBuy(
        address factory,
        address token,
        uint256 approveAmount,
        bytes calldata buyData,
        address recipient,
        uint256 minOut,
        uint256 value
    ) external {
        if (factory != FACTORY1 && factory != FACTORY2) {
            revert FactoryNotWhitelisted();
        }
        if (approveAmount > 0) {
            _safeApprove(token, factory, approveAmount);
        }
        (bool success,) = factory.call{value: value}(
            abi.encodePacked(bytes4(0x0490a7f3), buyData)
        );
        require(success, "Trenches buy failed");
    }

    // ========================================================================
    // Token Whitelist (V3: external registry call)
    // ========================================================================

    /// @notice Check if a token is whitelisted via the external registry.
    /// @dev Calls WhitelistRegistry.isWhitelisted() — a STATICCALL that reads
    ///      from the registry's own storage. Safe in delegatecall context because
    ///      the registry address is immutable (in bytecode, not storage).
    function _isWhitelisted(address token) internal view returns (bool) {
        return IWhitelistRegistry(WHITELIST_REGISTRY).isWhitelisted(token);
    }

    /// @notice Public view to check whitelist status (for external verification).
    function isWhitelisted(address token) external view returns (bool) {
        return _isWhitelisted(token);
    }

    // ========================================================================
    // Internal: Safe Approve (matching original OZ v5 pattern)
    // ========================================================================

    /// @dev Approve with reset-on-failure pattern (handles USDT-style non-standard approve).
    function _safeApprove(address token, address spender, uint256 amount) internal {
        IERC20(token).forceApprove(spender, amount);
    }

    /// @dev Allow receiving ETH (needed for unwrapWETH when WETH sends ETH back).
    receive() external payable {}
}
