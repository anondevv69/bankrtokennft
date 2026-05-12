// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TestFeeToken} from "../src/TestFeeToken.sol";

/// @title DeployTestFeeToken
/// @notice Deploys a simple ERC20 laboratory token for Base Sepolia integration tests.
contract DeployTestFeeToken is Script {
    /// @dev Environment variables:
    ///      PRIVATE_KEY: deployer private key.
    ///      TEST_FEE_TOKEN_INITIAL_SUPPLY: optional raw wei-denominated supply. Defaults to 1,000,000 TFT.
    function run() external returns (TestFeeToken token) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        uint256 initialSupply = vm.envOr("TEST_FEE_TOKEN_INITIAL_SUPPLY", uint256(1_000_000 ether));

        console2.log("Deploying TestFeeToken");
        console2.log("Deployer:", deployer);
        console2.log("Initial supply:", initialSupply);

        vm.startBroadcast(deployerPrivateKey);
        token = new TestFeeToken(initialSupply);
        vm.stopBroadcast();

        console2.log("TestFeeToken deployed:", address(token));
    }
}
