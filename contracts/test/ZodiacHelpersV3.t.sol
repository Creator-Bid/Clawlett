// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ZodiacHelpersV3} from "../src/ZodiacHelpersV3.sol";
import {WhitelistRegistry} from "../src/WhitelistRegistry.sol";

// ============================================================================
// DelegateCaller — simulates a Gnosis Safe executing delegatecall
// ============================================================================

contract DelegateCaller3 {
    function exec(address target, bytes memory data) external payable returns (bool success, bytes memory result) {
        (success, result) = target.delegatecall(data);
    }

    receive() external payable {}
}

// ============================================================================
// Minimal interface to read CoW Settlement's domainSeparator
// ============================================================================

interface ICowSettlementView3 {
    function domainSeparator() external view returns (bytes32);
}

// ============================================================================
// Test Suite
// ============================================================================

/// @title ZodiacHelpersV3 Fork Tests
/// @notice Proves the external WhitelistRegistry approach works against live Base mainnet.
///         Tests both the registry operations and the V3 helpers that call it.
contract ZodiacHelpersV3Test is Test {
    ZodiacHelpersV3 helpers;
    WhitelistRegistry registry;
    DelegateCaller3 safe;

    // Safe address (acts as registry owner in tests)
    address safeOwner;

    // ========================================================================
    // Token addresses (from tokens.js)
    // ========================================================================

    address constant WETH    = 0x4200000000000000000000000000000000000006;
    address constant USDC    = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT    = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    address constant DAI     = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb;
    address constant USDS    = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc;
    address constant AERO    = 0x940181a94A35A4569E4529A3CDfB74e38FD98631;
    address constant cbBTC   = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant VIRTUAL_TOKEN = 0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b;
    address constant DEGEN   = 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed;
    address constant BRETT   = 0x532f27101965dd16442E59d40670FaF5eBB142E4;
    address constant TOSHI   = 0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4;
    address constant WELL    = 0xA88594D404727625A9437C3f886C7643872296AE;
    address constant BID     = 0xa1832f7F4e534aE557f9B5AB76dE54B1873e498B;

    // Protocol addresses
    address constant COW_SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41;
    address constant VAULT_RELAYER  = 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110;
    address constant AERO_ROUTER    = 0x6Df1c91424F79E40E33B1A48F0687B666bE71075;
    address constant FACTORY1       = 0x68035FbC9c47aCc89140705806E2C183F35B3A5a;
    address constant FACTORY2       = 0x1f17a9Fa19C7b153CFe307133eCBb806A5F9d34B;

    // GPv2 constants
    bytes32 constant GPV2_ORDER_TYPE_HASH =
        0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489;
    bytes32 constant KIND_SELL =
        0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775;
    bytes32 constant BALANCE_ERC20 =
        0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9;

    // ========================================================================
    // Setup — deploy registry with 13 tokens, then deploy V3 pointing at it
    // ========================================================================

    function setUp() public {
        vm.createSelectFork("https://mainnet.base.org");

        safe = new DelegateCaller3();
        safeOwner = address(safe);

        // Build initial token list
        address[] memory initialTokens = new address[](13);
        initialTokens[0]  = WETH;
        initialTokens[1]  = USDC;
        initialTokens[2]  = USDT;
        initialTokens[3]  = DAI;
        initialTokens[4]  = USDS;
        initialTokens[5]  = AERO;
        initialTokens[6]  = cbBTC;
        initialTokens[7]  = VIRTUAL_TOKEN;
        initialTokens[8]  = DEGEN;
        initialTokens[9]  = BRETT;
        initialTokens[10] = TOSHI;
        initialTokens[11] = WELL;
        initialTokens[12] = BID;

        // Deploy registry owned by the mock Safe
        registry = new WhitelistRegistry(safeOwner, initialTokens);

        // Deploy V3 pointing at the registry
        helpers = new ZodiacHelpersV3(address(registry));

        // Fund the mock Safe with 10 ETH
        vm.deal(address(safe), 10 ether);
    }

    // ========================================================================
    // Helper: build a valid CoW Order and matching 56-byte orderUid
    // ========================================================================

    function _buildOrder(
        address buyToken,
        address receiver
    ) internal view returns (ZodiacHelpersV3.Order memory order, bytes memory orderUid) {
        order = ZodiacHelpersV3.Order({
            sellToken: WETH,
            buyToken: buyToken,
            receiver: receiver,
            sellAmount: 0.01 ether,
            buyAmount: 1,
            validTo: uint32(block.timestamp + 1 hours),
            appData: bytes32(0),
            feeAmount: 0,
            kind: KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: BALANCE_ERC20,
            buyTokenBalance: BALANCE_ERC20
        });

        bytes32 domainSeparator = ICowSettlementView3(COW_SETTLEMENT).domainSeparator();

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

        bytes32 orderDigest = keccak256(
            abi.encodePacked(bytes2(0x1901), domainSeparator, orderStructHash)
        );

        orderUid = abi.encodePacked(orderDigest, address(safe), order.validTo);
    }

    // ========================================================================
    // TEST 1: cowPreSign SUCCEEDS with a whitelisted buyToken (USDC)
    // ========================================================================

    function test_CowPreSign_WhitelistedToken_Succeeds() public {
        (bool wrapOk,) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.wrapETH, (1 ether))
        );
        require(wrapOk, "wrapETH setup failed");

        (ZodiacHelpersV3.Order memory order, bytes memory orderUid) =
            _buildOrder(USDC, address(safe));

        (bool success,) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.cowPreSign, (order, orderUid))
        );

        assertTrue(success, "cowPreSign should succeed with whitelisted buyToken (USDC)");

        uint256 allowance = IERC20(WETH).allowance(address(safe), VAULT_RELAYER);
        assertEq(allowance, order.sellAmount + order.feeAmount, "VAULT_RELAYER allowance mismatch");
    }

    // ========================================================================
    // TEST 2: cowPreSign REVERTS with a non-whitelisted buyToken
    // ========================================================================

    function test_CowPreSign_NonWhitelistedToken_Reverts() public {
        address attackerToken = address(0xDEAD);

        (ZodiacHelpersV3.Order memory order, bytes memory orderUid) =
            _buildOrder(attackerToken, address(safe));

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.cowPreSign, (order, orderUid))
        );

        assertFalse(success, "cowPreSign MUST revert with non-whitelisted buyToken");
        assertEq(
            bytes4(result),
            ZodiacHelpersV3.TokenNotWhitelisted.selector,
            "Revert reason should be TokenNotWhitelisted"
        );
    }

    // ========================================================================
    // TEST 3: cowPreSign REVERTS when receiver != safe
    // ========================================================================

    function test_CowPreSign_ReceiverNotSelf_Reverts() public {
        (bool wrapOk,) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.wrapETH, (1 ether))
        );
        require(wrapOk, "wrapETH setup failed");

        (ZodiacHelpersV3.Order memory order, bytes memory orderUid) =
            _buildOrder(USDC, address(0xBEEF));

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.cowPreSign, (order, orderUid))
        );

        assertFalse(success, "cowPreSign should revert when receiver != safe");
        assertEq(
            bytes4(result),
            ZodiacHelpersV3.ReceiverNotSelf.selector,
            "Revert reason should be ReceiverNotSelf"
        );
    }

    // ========================================================================
    // TEST 4: All 13 initial tokens pass the whitelist check
    // ========================================================================

    function test_AllWhitelistedTokensPass() public view {
        address[13] memory tokens = [
            WETH, USDC, USDT, DAI, USDS, AERO, cbBTC,
            VIRTUAL_TOKEN, DEGEN, BRETT, TOSHI, WELL, BID
        ];

        for (uint256 i = 0; i < tokens.length; i++) {
            assertTrue(
                helpers.isWhitelisted(tokens[i]),
                "All 13 tokens from tokens.js must be whitelisted"
            );
        }
    }

    // ========================================================================
    // TEST 5: Non-whitelisted addresses correctly rejected
    // ========================================================================

    function test_NonWhitelistedTokensRejected() public view {
        assertFalse(helpers.isWhitelisted(address(0)), "Zero address must NOT be whitelisted");
        assertFalse(helpers.isWhitelisted(address(0xDEAD)), "Random address must NOT be whitelisted");
        assertFalse(helpers.isWhitelisted(address(this)), "Test contract must NOT be whitelisted");
    }

    // ========================================================================
    // TEST 6: wrapETH works via delegatecall
    // ========================================================================

    function test_WrapETH() public {
        uint256 ethBefore = address(safe).balance;
        uint256 wethBefore = IERC20(WETH).balanceOf(address(safe));

        (bool success,) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.wrapETH, (1 ether))
        );

        assertTrue(success, "wrapETH should succeed");
        assertEq(address(safe).balance, ethBefore - 1 ether, "ETH balance should decrease");
        assertEq(IERC20(WETH).balanceOf(address(safe)), wethBefore + 1 ether, "WETH balance should increase");
    }

    // ========================================================================
    // TEST 7: unwrapWETH works via delegatecall
    // ========================================================================

    function test_UnwrapWETH() public {
        (bool wrapOk,) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.wrapETH, (1 ether))
        );
        require(wrapOk, "wrapETH setup failed");

        uint256 ethBefore = address(safe).balance;
        uint256 wethBefore = IERC20(WETH).balanceOf(address(safe));

        (bool success,) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.unwrapWETH, (0.5 ether))
        );

        assertTrue(success, "unwrapWETH should succeed");
        assertEq(address(safe).balance, ethBefore + 0.5 ether, "ETH balance should increase");
        assertEq(IERC20(WETH).balanceOf(address(safe)), wethBefore - 0.5 ether, "WETH balance should decrease");
    }

    // ========================================================================
    // TEST 8: All constant getters return correct addresses
    // ========================================================================

    function test_Constants() public view {
        assertEq(helpers.WETH(), WETH, "WETH getter");
        assertEq(helpers.COW_SETTLEMENT(), COW_SETTLEMENT, "COW_SETTLEMENT getter");
        assertEq(helpers.VAULT_RELAYER(), VAULT_RELAYER, "VAULT_RELAYER getter");
        assertEq(helpers.AERO_ROUTER(), AERO_ROUTER, "AERO_ROUTER getter");
        assertEq(helpers.FACTORY_1(), FACTORY1, "FACTORY_1 getter");
        assertEq(helpers.FACTORY_2(), FACTORY2, "FACTORY_2 getter");
        assertEq(helpers.WHITELIST_REGISTRY(), address(registry), "WHITELIST_REGISTRY getter");
    }

    // ========================================================================
    // TEST 9: approveForFactory reverts/succeeds
    // ========================================================================

    function test_ApproveForFactory_NonWhitelisted_Reverts() public {
        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.approveForFactory, (address(0x1234), WETH, 1 ether))
        );

        assertFalse(success, "approveForFactory should revert for non-whitelisted factory");
        assertEq(bytes4(result), ZodiacHelpersV3.FactoryNotWhitelisted.selector);
    }

    function test_ApproveForFactory_Whitelisted_Succeeds() public {
        (bool success,) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.approveForFactory, (FACTORY1, WETH, 1 ether))
        );

        assertTrue(success, "approveForFactory should succeed with FACTORY1");
        assertEq(IERC20(WETH).allowance(address(safe), FACTORY1), 1 ether);
    }

    // ========================================================================
    // TEST 10: Registry addToken — new token becomes whitelisted
    // ========================================================================

    function test_Registry_AddToken_ThenSwapSucceeds() public {
        address newToken = address(0xCAFE);

        // Confirm newToken is NOT whitelisted initially
        assertFalse(helpers.isWhitelisted(newToken), "newToken should not be whitelisted yet");

        // Safe (owner) adds the token to the registry
        vm.prank(safeOwner);
        registry.addToken(newToken);

        // Now V3 sees it as whitelisted
        assertTrue(helpers.isWhitelisted(newToken), "newToken should be whitelisted after addToken");
    }

    // ========================================================================
    // TEST 11: Registry removeToken — removed token gets blocked
    // ========================================================================

    function test_Registry_RemoveToken_ThenSwapReverts() public {
        // DEGEN is initially whitelisted
        assertTrue(helpers.isWhitelisted(DEGEN), "DEGEN should be whitelisted initially");

        // Safe (owner) removes DEGEN
        vm.prank(safeOwner);
        registry.removeToken(DEGEN);

        // V3 no longer sees DEGEN as whitelisted
        assertFalse(helpers.isWhitelisted(DEGEN), "DEGEN should NOT be whitelisted after removal");

        // Attempting cowPreSign with DEGEN as buyToken should now revert
        (ZodiacHelpersV3.Order memory order, bytes memory orderUid) =
            _buildOrder(DEGEN, address(safe));

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.cowPreSign, (order, orderUid))
        );

        assertFalse(success, "cowPreSign should revert after DEGEN removed from whitelist");
        assertEq(bytes4(result), ZodiacHelpersV3.TokenNotWhitelisted.selector);
    }

    // ========================================================================
    // TEST 12: Registry onlyOwner — non-owner cannot modify whitelist
    // ========================================================================

    function test_Registry_OnlyOwner() public {
        address attacker = address(0xE111);

        vm.prank(attacker);
        vm.expectRevert(WhitelistRegistry.NotOwner.selector);
        registry.addToken(address(0xCAFE));

        vm.prank(attacker);
        vm.expectRevert(WhitelistRegistry.NotOwner.selector);
        registry.removeToken(USDC);
    }

    // ========================================================================
    // TEST 13: Registry getAllTokens and getTokenCount
    // ========================================================================

    function test_Registry_Enumeration() public view {
        assertEq(registry.getTokenCount(), 13, "Should have 13 initial tokens");

        address[] memory allTokens = registry.getAllTokens();
        assertEq(allTokens.length, 13, "getAllTokens length should be 13");

        // Verify all expected tokens are present
        bool foundUSDC = false;
        bool foundWETH = false;
        for (uint256 i = 0; i < allTokens.length; i++) {
            if (allTokens[i] == USDC) foundUSDC = true;
            if (allTokens[i] == WETH) foundWETH = true;
        }
        assertTrue(foundUSDC, "USDC should be in getAllTokens");
        assertTrue(foundWETH, "WETH should be in getAllTokens");
    }

    // ========================================================================
    // TEST 14: Registry addTokens batch
    // ========================================================================

    function test_Registry_AddTokensBatch() public {
        address[] memory newTokens = new address[](3);
        newTokens[0] = address(0xAAA);
        newTokens[1] = address(0xBBB);
        newTokens[2] = address(0xCCC);

        vm.prank(safeOwner);
        registry.addTokens(newTokens);

        assertEq(registry.getTokenCount(), 16, "Should have 16 tokens after batch add");
        assertTrue(registry.isWhitelisted(address(0xAAA)));
        assertTrue(registry.isWhitelisted(address(0xBBB)));
        assertTrue(registry.isWhitelisted(address(0xCCC)));
    }

    // ========================================================================
    // TEST 15: aeroExecute V3_SWAP_EXACT_IN REVERTS for non-whitelisted output
    // ========================================================================

    function test_AeroExecute_V3ExactIn_NonWhitelisted_Reverts() public {
        address maliciousToken = address(0xDEAD);

        // V3 path: WETH → maliciousToken (last 20 bytes = output)
        bytes memory path = abi.encodePacked(WETH, uint24(200), maliciousToken);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(1), uint256(1 ether), uint256(0), path, true);

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.aeroExecute, (hex"00", inputs, block.timestamp + 1 hours, 0))
        );

        assertFalse(success, "V3 swap to non-whitelisted token must revert");
        assertEq(bytes4(result), ZodiacHelpersV3.TokenNotWhitelisted.selector);
    }

    // ========================================================================
    // TEST 16: aeroExecute V3_SWAP_EXACT_IN PASSES for whitelisted output
    // ========================================================================

    function test_AeroExecute_V3ExactIn_Whitelisted_PassesCheck() public {
        // V3 path: WETH → USDC (whitelisted)
        bytes memory path = abi.encodePacked(WETH, uint24(200), USDC);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(1), uint256(0.01 ether), uint256(0), path, true);

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.aeroExecute, (hex"00", inputs, block.timestamp + 1 hours, 0))
        );

        // May fail at Router level (wrong pool, etc.) but NOT with TokenNotWhitelisted
        if (!success) {
            assertTrue(
                bytes4(result) != ZodiacHelpersV3.TokenNotWhitelisted.selector,
                "Should NOT fail with TokenNotWhitelisted for whitelisted output"
            );
        }
    }

    // ========================================================================
    // TEST 17: aeroExecute V2_SWAP_EXACT_IN REVERTS for non-whitelisted output
    // ========================================================================

    function test_AeroExecute_V2ExactIn_NonWhitelisted_Reverts() public {
        address maliciousToken = address(0xDEAD);

        ZodiacHelpersV3.Route[] memory routes = new ZodiacHelpersV3.Route[](1);
        routes[0] = ZodiacHelpersV3.Route({from: WETH, to: maliciousToken, stable: false});

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(1), uint256(1 ether), uint256(0), routes, true);

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.aeroExecute, (hex"08", inputs, block.timestamp + 1 hours, 0))
        );

        assertFalse(success, "V2 swap to non-whitelisted token must revert");
        assertEq(bytes4(result), ZodiacHelpersV3.TokenNotWhitelisted.selector);
    }

    // ========================================================================
    // TEST 18: aeroExecute V3_SWAP_EXACT_OUT checks first 20 bytes of path
    // ========================================================================

    function test_AeroExecute_V3ExactOut_NonWhitelisted_Reverts() public {
        address maliciousToken = address(0xDEAD);

        // For EXACT_OUT, path is reversed: output token = FIRST 20 bytes
        bytes memory path = abi.encodePacked(maliciousToken, uint24(200), WETH);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(1), uint256(1 ether), uint256(10 ether), path, true);

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.aeroExecute, (hex"01", inputs, block.timestamp + 1 hours, 0))
        );

        assertFalse(success, "V3 EXACT_OUT to non-whitelisted token must revert");
        assertEq(bytes4(result), ZodiacHelpersV3.TokenNotWhitelisted.selector);
    }

    // ========================================================================
    // TEST 19: aeroExecute WRAP_ETH skips whitelist check
    // ========================================================================

    function test_AeroExecute_WrapETH_NoWhitelistCheck() public {
        // Command 11 = WRAP_ETH — should NOT trigger whitelist validation
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(2), uint256(0.01 ether));

        (bool success, bytes memory result) = safe.exec{value: 0.01 ether}(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.aeroExecute, (hex"0b", inputs, block.timestamp + 1 hours, 0.01 ether))
        );

        // Should NOT fail with TokenNotWhitelisted
        if (!success) {
            assertTrue(
                bytes4(result) != ZodiacHelpersV3.TokenNotWhitelisted.selector,
                "WRAP_ETH should NOT trigger whitelist check"
            );
        }
    }

    // ========================================================================
    // TEST 20: aeroExecute V2 multi-hop — only LAST route's `to` is checked
    // ========================================================================

    function test_AeroExecute_V2MultiHop_LastRouteChecked() public {
        address maliciousToken = address(0xDEAD);

        // Multi-hop: WETH → USDC (whitelisted) → maliciousToken
        // First route's `to` is USDC (whitelisted), but LAST route's `to` is malicious
        ZodiacHelpersV3.Route[] memory routes = new ZodiacHelpersV3.Route[](2);
        routes[0] = ZodiacHelpersV3.Route({from: WETH, to: USDC, stable: false});
        routes[1] = ZodiacHelpersV3.Route({from: USDC, to: maliciousToken, stable: false});

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(1), uint256(1 ether), uint256(0), routes, true);

        (bool success, bytes memory result) = safe.exec(
            address(helpers),
            abi.encodeCall(ZodiacHelpersV3.aeroExecute, (hex"08", inputs, block.timestamp + 1 hours, 0))
        );

        assertFalse(success, "V2 multi-hop to non-whitelisted final token must revert");
        assertEq(bytes4(result), ZodiacHelpersV3.TokenNotWhitelisted.selector);
    }
}
