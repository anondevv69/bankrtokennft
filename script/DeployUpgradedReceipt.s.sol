// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BankrFeeRightsReceipt} from "../src/BankrFeeRightsReceipt.sol";

/// @title DeployUpgradedReceipt
/// @notice Deploys a fresh `BankrFeeRightsReceipt` with EIP-2981 royalties (2 % to vault),
///         then re-authorizes your existing escrows on the new receipt so all future mints
///         go to the upgraded contract.
///
///         The old receipt contract cannot be upgraded in-place; this is a new deployment.
///         NFTs already held by users on the old contract remain redeemable via the old escrow
///         bindings — add the old address to `VITE_RECEIPT_COLLECTION_ALIASES` so the app keeps
///         scanning it.
///
/// @dev Required env vars:
///        PRIVATE_KEY            — deployer (must be current TMPR owner on existing escrows)
///        ROYALTY_RECEIVER       — vault wallet that receives 2 % EIP-2981 on secondary sales
///
///      Optional env vars:
///        ESCROW_INITIAL_OWNER   — Ownable owner for the new TMPR (defaults to deployer)
///        BANKR_ESCROW           — existing BankrEscrowV3 to re-authorize (or set address(0) to skip)
///        CLANKER_ESCROW         — existing ClankerEscrowV1 to re-authorize
///        CLANKER_V4_ESCROW      — existing ClankerEscrowV4 to re-authorize
///
///      Example (Base mainnet — your current deployed addresses):
///
///        export ROYALTY_RECEIVER="0xaD740cab33E0a9aC0bEFb42b55C30ede3544f2EA"
///        export BANKR_ESCROW="0x6238698212D91845cD1c004DE85951055bB5b292"
///        export CLANKER_ESCROW="0x5Cf158b5915E5b0764Ca87760b0e46beF7A527E3"
///        export CLANKER_V4_ESCROW="0x3546A98C09fc5a3E162d510DB331C4dcEdB6EADa"
///
///        forge script script/DeployUpgradedReceipt.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL \
///          --private-key $PRIVATE_KEY \
///          --broadcast --verify \
///          --etherscan-api-key $ETHERSCAN_API_KEY
contract DeployUpgradedReceipt is Script {
    function run() external returns (BankrFeeRightsReceipt tmpr) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address royaltyReceiver = vm.envAddress("ROYALTY_RECEIVER");
        address configuredOwner = vm.envOr("ESCROW_INITIAL_OWNER", address(0));
        address finalOwner = configuredOwner == address(0) ? deployer : configuredOwner;

        address bankrEscrow    = vm.envOr("BANKR_ESCROW",      address(0));
        address clankerEscrow  = vm.envOr("CLANKER_ESCROW",    address(0));
        address clankerV4Escrow = vm.envOr("CLANKER_V4_ESCROW", address(0));

        console2.log("=== DeployUpgradedReceipt ===");
        console2.log("Deployer:         ", deployer);
        console2.log("Final owner:      ", finalOwner);
        console2.log("Royalty receiver: ", royaltyReceiver);

        vm.startBroadcast(deployerPrivateKey);

        tmpr = new BankrFeeRightsReceipt(deployer, royaltyReceiver);
        console2.log("New TMPR:         ", address(tmpr));

        if (bankrEscrow != address(0)) {
            tmpr.setEscrowAuthorized(bankrEscrow, true);
            console2.log("  Authorized BankrEscrowV3:    ", bankrEscrow);
        }
        if (clankerEscrow != address(0)) {
            tmpr.setEscrowAuthorized(clankerEscrow, true);
            console2.log("  Authorized ClankerEscrowV1:  ", clankerEscrow);
        }
        if (clankerV4Escrow != address(0)) {
            tmpr.setEscrowAuthorized(clankerV4Escrow, true);
            console2.log("  Authorized ClankerEscrowV4:  ", clankerV4Escrow);
        }

        if (finalOwner != deployer) {
            tmpr.transferOwnership(finalOwner);
            console2.log("Ownership transferred to final owner.");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Next steps ===");
        console2.log("1. Update env + Railway/Vercel:");
        console2.log("   VITE_DEFAULT_RECEIPT_COLLECTION=", address(tmpr));
        console2.log("   VITE_RECEIPT_COLLECTION_ALIASES= <old receipt(s)>");
        console2.log("");
        console2.log("2. Rebuild and redeploy the frontend.");
        console2.log("");
        console2.log("3. escrow.receipt() is immutable on existing escrows (still old TMPR).");
        console2.log("   Run DeployBankrEscrowSharedReceipt + DeployAddClankerV4 with TMPR_ADDRESS=<new>");
        console2.log("   to also deploy new escrows that mint on the upgraded receipt.");
        console2.log("");
        console2.log("4. On OpenSea: new contract auto-picks up EIP-2981 royalties.");
        console2.log("   Also set creator fee in OpenSea dashboard for redundancy.");
    }
}
