// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FeeRightsFixedSale} from "../src/FeeRightsFixedSale.sol";

/// @title DeployFeeRightsFixedSale
/// @notice Deploys the fixed-price ETH marketplace for ERC721 fee-rights receipts (or any ERC721).
/// @dev Reads two env vars:
///      - PRIVATE_KEY      — deployer private key (required)
///      - FEE_RECIPIENT    — vault wallet that receives the 2 % platform cut (required)
///
///      Production (Base mainnet):
///        export FEE_RECIPIENT=0xYourVaultWallet
///        forge script script/DeployFeeRightsFixedSale.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL --private-key $PRIVATE_KEY --broadcast
///
///      Testnet (Sepolia / Base Sepolia):
///        Same script with a testnet RPC and a throwaway FEE_RECIPIENT.
contract DeployFeeRightsFixedSale is Script {
    function run() external returns (FeeRightsFixedSale sale) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast(deployerPrivateKey);

        sale = new FeeRightsFixedSale(feeRecipient);

        vm.stopBroadcast();

        console2.log("FeeRightsFixedSale deployed:", address(sale));
        console2.log("  feeRecipient:", feeRecipient);
        console2.log("  FEE_BPS:     ", sale.FEE_BPS());
    }
}
