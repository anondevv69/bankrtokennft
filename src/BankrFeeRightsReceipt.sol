// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";

/// @title BankrFeeRightsReceipt
/// @notice ERC721 receipt minted when escrow finalizes custody of Bankr fee rights.
/// @dev Only the escrow contract may mint or burn. Burning does not require the NFT
/// holder to approve escrow; custody of Bankr rights is settled on-chain separately.
contract BankrFeeRightsReceipt is ERC721 {
    /// @notice Metadata for a minted receipt, keyed by `tokenId`.
    struct Position {
        address feeManager;
        bytes32 poolId;
        address token0;
        address token1;
        address seller;
    }

    address public immutable escrow;

    mapping(uint256 tokenId => Position) private _positions;

    error NotEscrow();
    error ZeroAddress();

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(address escrow_) ERC721("Bankr Fee Rights Receipt", "BFRR") {
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
    }

    /// @notice Mints a receipt to `to` after escrow has verified fee-right custody.
    function mint(address to, uint256 tokenId, Position calldata position) external onlyEscrow {
        _mint(to, tokenId);
        _positions[tokenId] = position;
    }

    /// @notice Burns a receipt after Bankr rights leave escrow (redeem or cancel path).
    function burn(uint256 tokenId) external onlyEscrow {
        _burn(tokenId);
        delete _positions[tokenId];
    }

    /// @notice Returns stored position data for a minted `tokenId`.
    function positionOf(uint256 tokenId) external view returns (Position memory) {
        return _positions[tokenId];
    }
}
