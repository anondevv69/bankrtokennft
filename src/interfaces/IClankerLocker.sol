// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IClankerLocker
/// @notice Minimal interface for Clanker's LpLockerv2 contract.
///         Clanker positions are identified by `uint256 lpTokenId` (the Uniswap V3 NFT position ID),
///         not a `bytes32 poolId`. Creator rights are split into an `admin` (who can reassign both
///         admin and recipient) and a `recipient` (who receives collected fees).
interface IClankerLocker {
    struct RewardRecipient {
        address admin;
        address recipient;
    }

    /// @notice Returns the full reward configuration for a locked LP position.
    /// @dev Struct fields: (lpTokenId, creatorReward, creator{admin,recipient}, interfacer{admin,recipient})
    function tokenRewards(uint256 tokenId)
        external
        view
        returns (
            uint256 lpTokenId,
            uint256 creatorReward,
            RewardRecipient memory creator,
            RewardRecipient memory interfacer
        );

    /// @notice Collects accrued LP fees and distributes them to the current recipient addresses.
    ///         Anyone may call; rewards are sent to the registered recipients.
    function collectRewards(uint256 tokenId) external;

    /// @notice Replaces the creator reward recipient. Must be called by the current `creator.admin`.
    function updateCreatorRewardRecipient(uint256 tokenId, address newRecipient) external;

    /// @notice Replaces the creator reward admin (transfers admin rights). Must be called by current `creator.admin`.
    function updateCreatorRewardAdmin(uint256 tokenId, address newAdmin) external;
}
