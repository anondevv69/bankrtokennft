// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GroupBuyEscrow} from "../src/GroupBuyEscrow.sol";

/// @title DeployGroupBuyEscrow
/// @notice Deploys the GroupBuyEscrow contract for timed group purchases and partial sales of TMPR receipts.
///
/// @dev Required env vars:
///      - PRIVATE_KEY        — deployer private key
///      - FEE_RECIPIENT      — vault wallet receiving the 2 % platform cut
///
///      Optional env var:
///      - PUSH_SPLIT_FACTORY — 0xSplits V2 PushSplitFactory (defaults to Base mainnet address)
///
///      Base mainnet (broadcast):
///        export FEE_RECIPIENT=0xYourVaultWallet
///        forge script script/DeployGroupBuyEscrow.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL --private-key $PRIVATE_KEY --broadcast --verify
///
///      Dry-run (no broadcast):
///        forge script script/DeployGroupBuyEscrow.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL --private-key $PRIVATE_KEY
///
///      After deployment:
///      1. Update VITE_GROUP_BUY_ESCROW_ADDRESS in your Vercel / .env with the deployed address.
///      2. The deployer owns nothing — GroupBuyEscrow is permissionless (no Ownable).
contract DeployGroupBuyEscrow is Script {
    /// @dev 0xSplits V2.2 PushSplitFactory on Base mainnet (verified via SPLIT_WALLET_IMPLEMENTATION() call).
    address public constant PUSH_SPLIT_FACTORY_BASE = 0x80f1B766817D04870f115fEBbcCADF8DBF75E017;

    function run() external returns (GroupBuyEscrow gbe) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        // Allow overriding the factory address for non-Base chains or testing.
        address factoryAddr;
        try vm.envAddress("PUSH_SPLIT_FACTORY") returns (address fa) {
            factoryAddr = fa;
        } catch {
            factoryAddr = PUSH_SPLIT_FACTORY_BASE;
        }

        console2.log("Deploying GroupBuyEscrow...");
        console2.log("  feeRecipient:     ", feeRecipient);
        console2.log("  pushSplitFactory: ", factoryAddr);

        vm.startBroadcast(deployerPrivateKey);
        gbe = new GroupBuyEscrow(feeRecipient, factoryAddr);
        vm.stopBroadcast();

        console2.log("GroupBuyEscrow deployed:", address(gbe));
        console2.log("");
        console2.log("Next steps:");
        console2.log("  1. Set VITE_GROUP_BUY_ESCROW_ADDRESS=%s in Vercel / .env", address(gbe));
        console2.log("  2. Verify: https://basescan.org/address/%s#code", address(gbe));
    }
}
