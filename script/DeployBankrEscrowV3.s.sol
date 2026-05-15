// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BankrEscrowV3} from "../src/BankrEscrowV3.sol";

/// @title DeployBankrEscrowV3
/// @notice Deploys Escrow V3 (balance-delta accounting + ERC721 receipt with on-chain SVG).
///         The receipt contract (BankrFeeRightsReceipt) is created inside the escrow constructor.
///
/// @dev Reads env vars:
///      PRIVATE_KEY           — deployer key (required)
///      ESCROW_INITIAL_OWNER  — optional final `Ownable` owner after deploy. The script deploys with the **deployer**
///                              as owner, allowlists fee managers, then calls `transferOwnership(finalOwner)` when
///                              this env var is set and differs from the deployer. If unset, deployer stays owner.
///                              **Note:** Foundry auto-loads `fee-rights-exchange/.env`; unset or comment out
///                              `ESCROW_INITIAL_OWNER` there if you want the deployer to remain owner.
///      INITIAL_FEE_MANAGERS  — comma-separated list of fee manager addresses to allowlist
///      FACTORY_NAME          — display name baked into NFT metadata at finalize for **every** address in INITIAL_FEE_MANAGERS (default: "Bankr").
///                              Use escrow `setFactoryName(manager, "Clanker")` after deploy when CSV mixes factories under different venues.
///
///      Production (Base mainnet):
///        export FACTORY_NAME="Bankr"
///        export INITIAL_FEE_MANAGERS=0xFeeManager1,0xFeeManager2
///        forge script script/DeployBankrEscrowV3.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL --private-key $PRIVATE_KEY --broadcast --verify \
///          --etherscan-api-key $ETHERSCAN_API_KEY
contract DeployBankrEscrowV3 is Script {
    function run() external returns (BankrEscrowV3 escrow) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address configuredOwner = vm.envOr("ESCROW_INITIAL_OWNER", address(0));
        address finalOwner = configuredOwner == address(0) ? deployer : configuredOwner;
        string memory feeManagersCsv = vm.envOr("INITIAL_FEE_MANAGERS", string(""));
        string memory factoryName = vm.envOr("FACTORY_NAME", string("Bankr"));

        console2.log("Deploying BankrEscrowV3");
        console2.log("  Deployer (broadcast): ", deployer);
        console2.log("  Final owner:          ", finalOwner);
        console2.log("  Factory name:         ", factoryName);

        vm.startBroadcast(deployerPrivateKey);

        // Ownable owner must be the broadcaster until allowlist/setup finishes.
        escrow = new BankrEscrowV3(deployer);

        _allowlistFeeManagers(escrow, feeManagersCsv, factoryName);

        if (finalOwner != deployer) {
            escrow.transferOwnership(finalOwner);
            console2.log("  Ownership transferred to final owner");
        }

        vm.stopBroadcast();

        console2.log("BankrEscrowV3 deployed:       ", address(escrow));
        console2.log("BankrFeeRightsReceipt deployed:", address(escrow.receipt()));
    }

    function _allowlistFeeManagers(BankrEscrowV3 escrow, string memory csv, string memory factoryName) private {
        address[] memory mgrs = _parseAddressCsv(csv);
        for (uint256 i = 0; i < mgrs.length; i++) {
            escrow.setFeeManagerAllowed(mgrs[i], true);
            escrow.setFactoryName(mgrs[i], factoryName);
            console2.log("  Allowed + named fee manager:", mgrs[i]);
        }
    }

    function _parseAddressCsv(string memory csv) internal view returns (address[] memory addresses) {
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
