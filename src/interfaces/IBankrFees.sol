// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IBankrFees
/// @notice Minimal Bankr fee manager interface used by the escrow proof of concept.
/// @dev Bankr docs identify the fee manager as the token fee `initializer` and
/// the fee-right position by its stable `poolId`.
interface IBankrFees {
    /// @notice Transfers the caller's beneficiary rights for `poolId` to `newBeneficiary`.
    /// @dev Bankr requires `msg.sender` to be the current beneficiary for the pool.
    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external;

    /// @notice Collects fees for the caller/current beneficiary on `poolId`.
    /// @return fees0 Amount of token0 fees collected.
    /// @return fees1 Amount of token1 fees collected.
    function collectFees(bytes32 poolId) external returns (uint256 fees0, uint256 fees1);

    /// @notice Returns the share allocation for `beneficiary` on `poolId`.
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256);

    /// @notice Returns cumulative token0 fee accounting for `poolId`.
    function getCumulatedFees0(bytes32 poolId) external view returns (uint256);

    /// @notice Returns cumulative token1 fee accounting for `poolId`.
    function getCumulatedFees1(bytes32 poolId) external view returns (uint256);

    /// @notice Returns the last token0 cumulative fee checkpoint for `beneficiary`.
    function getLastCumulatedFees0(bytes32 poolId, address beneficiary) external view returns (uint256);

    /// @notice Returns the last token1 cumulative fee checkpoint for `beneficiary`.
    function getLastCumulatedFees1(bytes32 poolId, address beneficiary) external view returns (uint256);
}
