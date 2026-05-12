// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title TestFeeToken
/// @notice Plain ERC20 used only for controlled Base Sepolia integration testing.
/// @dev This is not a protocol token. It has no owner, taxes, transfer limits,
/// or tokenomics beyond the constructor mint.
contract TestFeeToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("TestFeeToken", "TFT") {
        _mint(msg.sender, initialSupply);
    }
}
