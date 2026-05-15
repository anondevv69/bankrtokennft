// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BankrFeeRightsReceipt} from "../src/BankrFeeRightsReceipt.sol";
import {BankrEscrowV3} from "../src/BankrEscrowV3.sol";
import {ClankerEscrowV1} from "../src/ClankerEscrowV1.sol";

/// @title DeployTokenMarketplace
/// @notice Deploys the full Token Marketplace suite:
///           1. BankrFeeRightsReceipt  — shared TMPR ERC-721 collection
///           2. BankrEscrowV3          — handles Bankr fee-manager positions
///           3. ClankerEscrowV1        — handles Clanker LpLockerv2 positions
///         Both escrows are authorized to mint on the shared receipt.
///
/// @dev Required env vars:
///        PRIVATE_KEY           — deployer private key
///
///      Optional env vars:
///        ESCROW_INITIAL_OWNER    — final Ownable owner (defaults to deployer)
///        BANKR_FEE_MANAGERS      — comma-separated Bankr fee-manager addresses to allowlist
///        CLANKER_LOCKERS         — comma-separated Clanker LpLocker addresses to allowlist
///
///      Example (Base mainnet):
///
///        # Bankr mainnet fee manager (confirmed from on-chain events):
///        export BANKR_FEE_MANAGERS="0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"
///
///        # Clanker v3.1 LP Locker on Base mainnet:
///        export CLANKER_LOCKERS="0x33e2Eda238edcF470309b8c6D228986A1204c8f9"
///
///        forge script script/DeployTokenMarketplace.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL \
///          --private-key $PRIVATE_KEY \
///          --broadcast --verify \
///          --etherscan-api-key $ETHERSCAN_API_KEY
contract DeployTokenMarketplace is Script {
    function run()
        external
        returns (BankrFeeRightsReceipt tmpr, BankrEscrowV3 bankrEscrow, ClankerEscrowV1 clankerEscrow)
    {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address configuredOwner = vm.envOr("ESCROW_INITIAL_OWNER", address(0));
        address finalOwner = configuredOwner == address(0) ? deployer : configuredOwner;

        string memory bankrCsv = vm.envOr("BANKR_FEE_MANAGERS", string(""));
        string memory clankerCsv = vm.envOr("CLANKER_LOCKERS", string(""));

        console2.log("=== Token Marketplace deployment ===");
        console2.log("Deployer:          ", deployer);
        console2.log("Final owner:       ", finalOwner);
        console2.log("Bankr fee managers:", bankrCsv);
        console2.log("Clanker lockers:   ", clankerCsv);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy shared TMPR receipt collection (deployer is initial owner so we can authorize escrows)
        tmpr = new BankrFeeRightsReceipt(deployer);
        console2.log("BankrFeeRightsReceipt (TMPR):", address(tmpr));

        // 2. Deploy Bankr escrow
        bankrEscrow = new BankrEscrowV3(deployer, tmpr);
        console2.log("BankrEscrowV3:               ", address(bankrEscrow));

        // 3. Deploy Clanker escrow
        clankerEscrow = new ClankerEscrowV1(deployer, tmpr);
        console2.log("ClankerEscrowV1:             ", address(clankerEscrow));

        // 4. Authorize both escrows on the receipt collection
        tmpr.setEscrowAuthorized(address(bankrEscrow), true);
        tmpr.setEscrowAuthorized(address(clankerEscrow), true);
        console2.log("Both escrows authorized on TMPR.");

        // 5. Configure Bankr fee managers
        if (bytes(bankrCsv).length > 0) {
            address[] memory managers = _parseAddressCsv(bankrCsv);
            for (uint256 i = 0; i < managers.length; i++) {
                bankrEscrow.setFeeManagerAllowed(managers[i], true);
                bankrEscrow.setFactoryName(managers[i], "Bankr");
                console2.log("  Bankr fee manager allowed:", managers[i]);
            }
        }

        // 6. Configure Clanker lockers
        if (bytes(clankerCsv).length > 0) {
            address[] memory lockers = _parseAddressCsv(clankerCsv);
            for (uint256 i = 0; i < lockers.length; i++) {
                clankerEscrow.setLockerAllowed(lockers[i], true);
                clankerEscrow.setFactoryName(lockers[i], "Clanker");
                console2.log("  Clanker locker allowed:   ", lockers[i]);
            }
        }

        // 7. Transfer ownership to final owner (if different from deployer)
        if (finalOwner != deployer) {
            tmpr.transferOwnership(finalOwner);
            bankrEscrow.transferOwnership(finalOwner);
            clankerEscrow.transferOwnership(finalOwner);
            console2.log("Ownership transferred to final owner.");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Deployed addresses (paste into .env) ===");
        console2.log("VITE_DEFAULT_RECEIPT_COLLECTION=", address(tmpr));
        console2.log("VITE_BANKR_ESCROW_ADDRESS=       ", address(bankrEscrow));
        console2.log("VITE_CLANKER_ESCROW_ADDRESS=     ", address(clankerEscrow));
    }

    // ── CSV parser (copied from DeployBankrEscrowV3) ──────────────────────────

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
