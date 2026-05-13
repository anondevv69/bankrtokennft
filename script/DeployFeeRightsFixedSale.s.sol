// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FeeRightsFixedSale} from "../src/FeeRightsFixedSale.sol";

/// @title DeployFeeRightsFixedSale
/// @notice Deploys the fixed-price ETH marketplace for ERC721 fee-rights receipts (or any ERC721).
/// @dev forge script script/DeployFeeRightsFixedSale.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
///      forge script script/DeployFeeRightsFixedSale.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast
contract DeployFeeRightsFixedSale is Script {
    function run() external returns (FeeRightsFixedSale sale) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        sale = new FeeRightsFixedSale();

        vm.stopBroadcast();

        console2.log("FeeRightsFixedSale deployed:", address(sale));
    }
}
