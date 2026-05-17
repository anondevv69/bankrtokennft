// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GroupBuyEscrow} from "../src/GroupBuyEscrow.sol";
import {MockERC721} from "../src/test/MockERC721.sol";

/// @title DeployGroupBuyTestnet
/// @notice Deploys GroupBuyEscrow + a MockERC721 on Base Sepolia (or any testnet).
///         Also mints token #1 to the deployer so you can immediately test listing.
///
/// Usage (Base Sepolia):
///   forge script script/DeployGroupBuyTestnet.s.sol \
///     --rpc-url https://sepolia.base.org \
///     --private-key $PRIVATE_KEY \
///     --broadcast
///
/// Required env vars:
///   PRIVATE_KEY        — testnet deployer key
///   FEE_RECIPIENT      — address to receive 2% platform fee (can be your own wallet on testnet)
///
/// After deploy, copy the printed addresses into bankr-app/.env.local:
///   VITE_CHAIN_ID=84532
///   VITE_GROUP_BUY_ESCROW_ADDRESS=<GroupBuyEscrow>
///   VITE_DEFAULT_RECEIPT_COLLECTION=<MockERC721>
///   VITE_MARKETPLACE_ADDRESS=<leave blank or use a testnet FeeRightsFixedSale>
contract DeployGroupBuyTestnet is Script {
    /// @dev 0xSplits V2.2 PushSplitFactory — same address on Base Sepolia as mainnet.
    address public constant PUSH_SPLIT_FACTORY = 0x80f1B766817D04870f115fEBbcCADF8DBF75E017;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer); // default to deployer on testnet

        console2.log("Deployer:     ", deployer);
        console2.log("feeRecipient: ", feeRecipient);
        console2.log("chain:        ", block.chainid);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Mock ERC-721 for test listings
        MockERC721 mockNft = new MockERC721(deployer);
        // Mint token #1 to deployer to test listing immediately
        mockNft.mint(deployer, 1);

        // 2. GroupBuyEscrow
        GroupBuyEscrow gbe = new GroupBuyEscrow(feeRecipient, PUSH_SPLIT_FACTORY);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployed ===");
        console2.log("MockERC721:     ", address(mockNft));
        console2.log("GroupBuyEscrow: ", address(gbe));
        console2.log("");
        console2.log("=== .env.local for bankr-app ===");
        console2.log("VITE_CHAIN_ID=84532");
        console2.log("VITE_RPC_URL=https://sepolia.base.org");
        console2.log("VITE_DEFAULT_RECEIPT_COLLECTION=%s", address(mockNft));
        console2.log("VITE_MARKETPLACE_ADDRESS=");
        console2.log("VITE_BANKR_ESCROW_ADDRESS=");
        console2.log("VITE_CLANKER_ESCROW_ADDRESS=");
        console2.log("VITE_CLANKER_V4_ESCROW_ADDRESS=");
        console2.log("VITE_GROUP_BUY_ESCROW_ADDRESS=%s", address(gbe));
        console2.log("");
        console2.log("Token #1 minted to deployer - approve & list to test group buy.");
    }
}
