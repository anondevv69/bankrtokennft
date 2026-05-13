// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BankrEscrowV3} from "../src/BankrEscrowV3.sol";

/// @title DeployBankrEscrowV3
/// @notice Deploys Escrow V3 (balance-delta accounting + ERC721 receipt). The receipt contract is created by the escrow constructor.
/// @dev Production: Base mainnet. Example:
///      forge script script/DeployBankrEscrowV3.s.sol --rpc-url $BASE_MAINNET_RPC_URL --private-key $PRIVATE_KEY --broadcast
///      Lab: same script with Base Sepolia RPC for throwaway testing.
contract DeployBankrEscrowV3 is Script {
    function run() external returns (BankrEscrowV3 escrow) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address configuredOwner = vm.envOr("ESCROW_INITIAL_OWNER", address(0));
        address initialOwner = configuredOwner == address(0) ? deployer : configuredOwner;
        string memory feeManagersCsv = vm.envOr("INITIAL_FEE_MANAGERS", string(""));

        console2.log("Deploying BankrEscrowV3");
        console2.log("Deployer:", deployer);
        console2.log("Initial owner:", initialOwner);

        vm.startBroadcast(deployerPrivateKey);

        escrow = new BankrEscrowV3(initialOwner);
        address[] memory feeManagers = _parseAddressCsv(feeManagersCsv);

        for (uint256 i = 0; i < feeManagers.length; i++) {
            escrow.setFeeManagerAllowed(feeManagers[i], true);
            console2.log("Allowed fee manager:", feeManagers[i]);
        }

        vm.stopBroadcast();

        console2.log("BankrEscrowV3 deployed:", address(escrow));
        console2.log("BankrFeeRightsReceipt:", address(escrow.receipt()));
    }

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

    function _slice(string memory input, uint256 start, uint256 end) internal pure returns (string memory result) {
        bytes memory inputBytes = bytes(input);
        bytes memory output = new bytes(end - start);

        for (uint256 i = start; i < end; i++) {
            output[i - start] = inputBytes[i];
        }

        result = string(output);
    }
}
