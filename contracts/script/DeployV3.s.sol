// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/WhitelistRegistry.sol";
import "../src/ZodiacHelpersV3.sol";

/// @title DeployV3
/// @notice Deploys WhitelistRegistry + ZodiacHelpersV3 to Base mainnet.
///
/// Usage:
///   forge script script/DeployV3.s.sol:DeployV3 \
///     --rpc-url https://mainnet.base.org \
///     --broadcast --interactive \
///     --verify --verifier sourcify
contract DeployV3 is Script {
    // The Gnosis Safe that owns the registry and the agent wallet
    address constant SAFE = 0x476A12e7deAcb917B057890fC4fF6C334FDB0d1F;

    function run() external {
        // Build the initial token whitelist (matching tokens.js + USDbC from current live V2)
        address[] memory tokens = new address[](14);
        tokens[0]  = 0x4200000000000000000000000000000000000006; // WETH
        tokens[1]  = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
        tokens[2]  = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2; // USDT
        tokens[3]  = 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb; // DAI
        tokens[4]  = 0x820C137fa70C8691f0e44Dc420a5e53c168921Dc; // USDS
        tokens[5]  = 0x940181a94A35A4569E4529A3CDfB74e38FD98631; // AERO
        tokens[6]  = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf; // cbBTC
        tokens[7]  = 0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b; // VIRTUAL
        tokens[8]  = 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed; // DEGEN
        tokens[9]  = 0x532f27101965dd16442E59d40670FaF5eBB142E4; // BRETT
        tokens[10] = 0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4; // TOSHI
        tokens[11] = 0xA88594D404727625A9437C3f886C7643872296AE; // WELL
        tokens[12] = 0xa1832f7F4e534aE557f9B5AB76dE54B1873e498B; // BID
        tokens[13] = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA; // USDbC

        vm.startBroadcast();

        // Step 1: Deploy the WhitelistRegistry (owned by the Safe)
        WhitelistRegistry registry = new WhitelistRegistry(SAFE, tokens);

        // Step 2: Deploy ZodiacHelpersV3 (points to the registry)
        ZodiacHelpersV3 helpers = new ZodiacHelpersV3(address(registry));

        vm.stopBroadcast();

        // Log deployed addresses
        console.log("============================================");
        console.log("  WhitelistRegistry:", address(registry));
        console.log("  ZodiacHelpersV3:  ", address(helpers));
        console.log("============================================");
        console.log("");
        console.log("Next steps:");
        console.log("  1. Generate permission swap batch:");
        console.log("     cd clawlett/scripts");
        console.log("     node manage-whitelist.js --setup-batch <registry-addr> <helpers-addr>");
        console.log("");
        console.log("  2. Upload batch JSON to Safe web UI, sign, execute");
        console.log("");
        console.log("  3. Finalize config:");
        console.log("     node manage-whitelist.js --finalize <helpers-addr> <registry-addr>");
    }
}
