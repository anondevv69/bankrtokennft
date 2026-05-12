// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BankrEscrowTest} from "../src/BankrEscrowTest.sol";

/// @title DeployBankrEscrowTest
/// @notice Deploys the Bankr fee-rights escrow PoC and optionally seeds fee-manager allowlist entries.
/// @dev Use Foundry CLI flags for simulation/broadcast:
///      forge script script/DeployBankrEscrowTest.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
///      forge script script/DeployBankrEscrowTest.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast
contract DeployBankrEscrowTest is Script {
    /// @notice Deploys escrow and applies initial fee manager allowlist entries.
    /// @dev Environment variables:
    ///      ESCROW_INITIAL_OWNER: owner/admin address. Defaults to deployer if unset.
    ///      INITIAL_FEE_MANAGERS: optional comma-separated address list.
    function run() external returns (BankrEscrowTest escrow) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address configuredOwner = vm.envOr("ESCROW_INITIAL_OWNER", address(0));
        address initialOwner = configuredOwner == address(0) ? deployer : configuredOwner;
        string memory feeManagersCsv = vm.envOr("INITIAL_FEE_MANAGERS", string(""));

        console2.log("Deploying BankrEscrowTest");
        console2.log("Deployer:", deployer);
        console2.log("Initial owner:", initialOwner);

        vm.startBroadcast(deployerPrivateKey);

        escrow = new BankrEscrowTest(initialOwner);
        address[] memory feeManagers = _parseAddressCsv(feeManagersCsv);

        for (uint256 i = 0; i < feeManagers.length; i++) {
            escrow.setFeeManagerAllowed(feeManagers[i], true);
            console2.log("Allowed fee manager:", feeManagers[i]);
        }

        vm.stopBroadcast();

        console2.log("BankrEscrowTest deployed:", address(escrow));
    }

    /// @dev Parses a comma-separated address list. Empty input returns an empty array.
    function _parseAddressCsv(string memory csv) internal pure returns (address[] memory addresses) {
        bytes memory input = bytes(csv);
        if (input.length == 0) return new address[](0);

        uint256 count = 1;
        for (uint256 i = 0; i < input.length; i++) {
            if (input[i] == ",") count++;
        }

        addresses = new address[](count);
        uint256 start = 0;
        uint256 index = 0;

        for (uint256 i = 0; i <= input.length; i++) {
            if (i == input.length || input[i] == ",") {
                addresses[index] = vm.parseAddress(_slice(csv, start, i));
                start = i + 1;
                index++;
            }
        }
    }

    /// @dev Returns the substring in the half-open range [start, end).
    function _slice(string memory input, uint256 start, uint256 end) internal pure returns (string memory result) {
        bytes memory inputBytes = bytes(input);
        bytes memory output = new bytes(end - start);

        for (uint256 i = start; i < end; i++) {
            output[i - start] = inputBytes[i];
        }

        result = string(output);
    }
}
