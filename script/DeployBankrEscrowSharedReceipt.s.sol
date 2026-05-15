// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BankrFeeRightsReceipt} from "../src/BankrFeeRightsReceipt.sol";
import {BankrEscrowV3} from "../src/BankrEscrowV3.sol";

/// @title DeployBankrEscrowSharedReceipt
/// @notice Deploys `BankrEscrowV3` wired to an **existing** TMPR (`BankrFeeRightsReceipt`) so Bankr
///         finalizes mint into the **same** ERC-721 contract (and OpenSea collection) as Clanker.
///
///         Use when your canonical TMPR is already live (e.g. from `DeployTokenMarketplace` or the
///         receipt Clanker escrows use) and you must not run `DeployBankrEscrowV3` alone — that script
///         deploys a **new** receipt = a **second** OpenSea collection.
///
/// @dev Required env vars:
///        PRIVATE_KEY           — deployer private key (must be current TMPR `Ownable` owner)
///        TMPR_ADDRESS          — existing `BankrFeeRightsReceipt` (same as `VITE_DEFAULT_RECEIPT_COLLECTION`)
///
///      Optional env vars (same semantics as `DeployBankrEscrowV3`):
///        ESCROW_INITIAL_OWNER  — final `Ownable` owner for the new escrow (defaults to deployer)
///        INITIAL_FEE_MANAGERS  — comma-separated fee managers to allowlist
///        FACTORY_NAME          — baked into receipt SVG for those managers (default: "Bankr")
///
///      Example (Base mainnet — TMPR = receipt from your Clanker / Token Marketplace deploy):
///
///        export TMPR_ADDRESS="0x<canonical_tmpr>"
///        export INITIAL_FEE_MANAGERS="0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"
///        export FACTORY_NAME="Bankr"
///
///        forge script script/DeployBankrEscrowSharedReceipt.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL \
///          --private-key $PRIVATE_KEY \
///          --broadcast --verify \
///          --etherscan-api-key $ETHERSCAN_API_KEY
contract DeployBankrEscrowSharedReceipt is Script {
    function run() external returns (BankrEscrowV3 escrow) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address tmprAddr = vm.envAddress("TMPR_ADDRESS");
        address configuredOwner = vm.envOr("ESCROW_INITIAL_OWNER", address(0));
        address finalOwner = configuredOwner == address(0) ? deployer : configuredOwner;
        string memory feeManagersCsv = vm.envOr("INITIAL_FEE_MANAGERS", string(""));
        string memory factoryName = vm.envOr("FACTORY_NAME", string("Bankr"));

        BankrFeeRightsReceipt tmpr = BankrFeeRightsReceipt(tmprAddr);

        console2.log("=== BankrEscrowV3 (shared TMPR) ===");
        console2.log("Deployer:         ", deployer);
        console2.log("Final owner:      ", finalOwner);
        console2.log("TMPR receipt:     ", address(tmpr));

        vm.startBroadcast(deployerPrivateKey);

        escrow = new BankrEscrowV3(deployer, tmpr);
        console2.log("BankrEscrowV3:    ", address(escrow));

        tmpr.setEscrowAuthorized(address(escrow), true);
        console2.log("BankrEscrowV3 authorized on TMPR.");

        _allowlistFeeManagers(escrow, feeManagersCsv, factoryName);

        if (finalOwner != deployer) {
            escrow.transferOwnership(finalOwner);
            console2.log("Escrow ownership transferred to final owner.");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Add to .env (rebuild app) ===");
        console2.log("VITE_DEFAULT_RECEIPT_COLLECTION=", address(tmpr));
        console2.log("VITE_BANKR_ESCROW_ADDRESS=", address(escrow));
        console2.log("(or VITE_ESCROW_ADDRESS= same value)");
    }

    function _allowlistFeeManagers(BankrEscrowV3 escrow_, string memory csv, string memory factoryName) private {
        address[] memory mgrs = _parseAddressCsv(csv);
        for (uint256 i = 0; i < mgrs.length; i++) {
            escrow_.setFeeManagerAllowed(mgrs[i], true);
            escrow_.setFactoryName(mgrs[i], factoryName);
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
