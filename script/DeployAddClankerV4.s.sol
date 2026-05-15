// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BankrFeeRightsReceipt} from "../src/BankrFeeRightsReceipt.sol";
import {ClankerEscrowV4} from "../src/ClankerEscrowV4.sol";

/// @title DeployAddClankerV4
/// @notice Deploys `ClankerEscrowV4` and authorizes it on an **existing** TMPR receipt collection.
///         Use this when you already have BankrFeeRightsReceipt + BankrEscrowV3 + ClankerEscrowV1
///         deployed and only need to add v4 support.
///
/// @dev Required env vars:
///        PRIVATE_KEY           — deployer private key (must be current TMPR owner)
///        TMPR_ADDRESS          — deployed BankrFeeRightsReceipt address
///
///      Optional env vars:
///        ESCROW_INITIAL_OWNER   — final Ownable owner (defaults to deployer)
///        CLANKER_V4_LOCKERS     — comma-separated v4 locker addresses to allowlist
///                                 Defaults to both known Base mainnet v4 lockers:
///                                   ClankerLpLockerFeeConversion 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496
///                                   ClankerLpLocker              0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0
///
///      Example (Base mainnet):
///        export TMPR_ADDRESS="0x<your_tmpr>"
///        export CLANKER_V4_LOCKERS="0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496,0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0"
///
///        forge script script/DeployAddClankerV4.s.sol \
///          --rpc-url $BASE_MAINNET_RPC_URL \
///          --private-key $PRIVATE_KEY \
///          --broadcast --verify \
///          --etherscan-api-key $ETHERSCAN_API_KEY
contract DeployAddClankerV4 is Script {
    // Known Base mainnet Clanker v4 lockers used as defaults when env var is unset.
    address constant DEFAULT_V4_LOCKER_FEE_CONVERSION = 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496;
    address constant DEFAULT_V4_LOCKER_LP = 0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0;

    function run() external returns (ClankerEscrowV4 clankerEscrowV4) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address tmprAddr = vm.envAddress("TMPR_ADDRESS");
        address configuredOwner = vm.envOr("ESCROW_INITIAL_OWNER", address(0));
        address finalOwner = configuredOwner == address(0) ? deployer : configuredOwner;

        string memory v4Csv = vm.envOr(
            "CLANKER_V4_LOCKERS",
            string(
                abi.encodePacked(
                    vm.toString(DEFAULT_V4_LOCKER_FEE_CONVERSION),
                    ",",
                    vm.toString(DEFAULT_V4_LOCKER_LP)
                )
            )
        );

        BankrFeeRightsReceipt tmpr = BankrFeeRightsReceipt(tmprAddr);

        console2.log("=== ClankerEscrowV4 deployment ===");
        console2.log("Deployer:         ", deployer);
        console2.log("Final owner:      ", finalOwner);
        console2.log("TMPR receipt:     ", address(tmpr));
        console2.log("V4 lockers:       ", v4Csv);

        vm.startBroadcast(deployerPrivateKey);

        clankerEscrowV4 = new ClankerEscrowV4(deployer, tmpr);
        console2.log("ClankerEscrowV4:  ", address(clankerEscrowV4));

        // Authorize on the shared receipt collection (deployer must be TMPR owner).
        tmpr.setEscrowAuthorized(address(clankerEscrowV4), true);
        console2.log("ClankerEscrowV4 authorized on TMPR.");

        // Allow v4 locker addresses.
        address[] memory lockers = _parseAddressCsv(v4Csv);
        for (uint256 i = 0; i < lockers.length; i++) {
            clankerEscrowV4.setLockerAllowed(lockers[i], true);
            clankerEscrowV4.setFactoryName(lockers[i], "Clanker v4");
            console2.log("  V4 locker allowed: ", lockers[i]);
        }

        // Transfer ownership.
        if (finalOwner != deployer) {
            clankerEscrowV4.transferOwnership(finalOwner);
            console2.log("Ownership transferred to final owner.");
        }

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== Add to .env ===");
        console2.log("VITE_CLANKER_V4_ESCROW_ADDRESS=", address(clankerEscrowV4));
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
