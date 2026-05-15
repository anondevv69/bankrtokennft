// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IClankerLockerV4
/// @notice Minimal interface for Clanker v4's `ClankerLpLockerFeeConversion` contract.
///         v4 rewards are keyed by `(address token, uint256 rewardIndex)` instead of
///         `uint256 lpTokenId` (Uniswap V3 NFT id) used in v3.x `LpLockerv2`.
///
///         Known Base mainnet v4 locker addresses:
///           ClankerLpLockerFeeConversion  0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496
///           ClankerLpLocker               0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0
interface IClankerLockerV4 {
    /// @notice Uniswap v4 pool key embedded in every token reward record.
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @notice Full reward configuration for a Clanker v4 deployed token.
    /// @dev `rewardAdmins[i]` controls index `i`; `rewardRecipients[i]` receives fees at index `i`.
    struct TokenRewardInfo {
        address token;
        PoolKey poolKey;
        uint256 positionId;
        uint256 numPositions;
        uint16[] rewardBps;
        address[] rewardAdmins;
        address[] rewardRecipients;
    }

    /// @notice Returns the full reward configuration for a deployed token.
    function tokenRewards(address token) external view returns (TokenRewardInfo memory);

    /// @notice Replaces the fee recipient for `rewardIndex`. Callable by `rewardAdmins[rewardIndex]`.
    function updateRewardRecipient(address token, uint256 rewardIndex, address newRecipient) external;

    /// @notice Replaces the admin for `rewardIndex`. Callable by the current `rewardAdmins[rewardIndex]`.
    function updateRewardAdmin(address token, uint256 rewardIndex, address newAdmin) external;

    /// @notice Collects accrued LP fees and distributes to current recipients. Anyone may call.
    function collectRewards(address token) external;
}
