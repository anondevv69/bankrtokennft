// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/// @title MockERC721
/// @notice Minimal mintable ERC-721 for testnet / local dev use with GroupBuyEscrow.
///         Call `mint(to, tokenId)` to issue tokens.
contract MockERC721 is ERC721, Ownable {
    constructor(address initialOwner)
        ERC721("Mock Fee Rights Receipt", "MFRT")
        Ownable(initialOwner)
    {}

    function mint(address to, uint256 tokenId) external onlyOwner {
        _mint(to, tokenId);
    }
}
