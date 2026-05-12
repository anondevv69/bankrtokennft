// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IBankrFees} from "./interfaces/IBankrFees.sol";

/// @title BankrEscrowTest
/// @notice Custody proof of concept for transferable Bankr fee rights.
/// @dev This contract intentionally does not mint NFTs, run a marketplace, or
/// settle purchases. It only proves that fee rights can be held by a contract,
/// claimed while escrowed, and transferred back out by the contract.
contract BankrEscrowTest is Ownable, ReentrancyGuard {
    /// @notice Fee managers approved for escrow registration.
    mapping(address feeManager => bool allowed) public allowedFeeManager;

    /// @notice Seller that pre-registered a deposit before transferring rights to escrow.
    mapping(bytes32 poolId => address seller) public pendingSeller;

    /// @notice Fee manager attached to a pre-registered deposit.
    mapping(bytes32 poolId => address feeManager) public pendingFeeManagerForPool;

    /// @notice Original seller for each escrowed Bankr pool.
    mapping(bytes32 poolId => address seller) public originalOwner;

    /// @notice Bankr fee manager address for each escrowed Bankr pool.
    mapping(bytes32 poolId => address feeManager) public feeManagerForPool;

    /// @notice True when a pool's Bankr fee rights are registered in escrow.
    mapping(bytes32 poolId => bool escrowed) public isEscrowed;

    /// @notice Token0 fees claimed by escrow while each pool is active.
    mapping(bytes32 poolId => uint256 amount) public accruedFees0;

    /// @notice Token1 fees claimed by escrow while each pool is active.
    mapping(bytes32 poolId => uint256 amount) public accruedFees1;

    /// @notice Emitted when the owner changes fee manager allowlist status.
    event FeeManagerAllowlistUpdated(address indexed feeManager, bool allowed);

    /// @notice Emitted after a seller pre-registers intent to escrow rights.
    event DepositPrepared(bytes32 indexed poolId, address indexed feeManager, address indexed seller);

    /// @notice Emitted after escrow custody is verified and recorded.
    event RightsDeposited(bytes32 indexed poolId, address indexed feeManager, address indexed originalOwner);

    /// @notice Emitted after escrow transfers fee rights to a recipient.
    event RightsReleased(bytes32 indexed poolId, address indexed feeManager, address indexed to);

    /// @notice Emitted after escrow returns fee rights to the original seller.
    event RightsCancelled(bytes32 indexed poolId, address indexed feeManager, address indexed originalOwner);

    /// @notice Emitted after escrow claims fees while it owns the rights.
    event FeesClaimed(bytes32 indexed poolId, address indexed feeManager, uint256 fees0, uint256 fees1);

    error ZeroAddress();
    error RightsAlreadyEscrowed(bytes32 poolId);
    error DepositAlreadyPending(bytes32 poolId);
    error DepositNotPrepared(bytes32 poolId);
    error RightsNotEscrowed(bytes32 poolId);
    error EscrowDoesNotOwnRights(bytes32 poolId);
    error CallerDoesNotOwnRights(bytes32 poolId);
    error FeeManagerNotAllowed(address feeManager);
    error TransferVerificationFailed(bytes32 poolId, address expectedBeneficiary);
    error UnauthorizedCaller(address caller);

    /// @param initialOwner Admin address allowed to release rights in this proof of concept.
    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Allows or blocks a Bankr fee manager for escrow deposits.
    /// @param feeManager Fee manager address to update.
    /// @param allowed True to allow deposits from the manager, false to block them.
    function setFeeManagerAllowed(address feeManager, bool allowed) external onlyOwner {
        if (feeManager == address(0)) revert ZeroAddress();

        allowedFeeManager[feeManager] = allowed;

        emit FeeManagerAllowlistUpdated(feeManager, allowed);
    }

    /// @notice Pre-registers a seller before they transfer Bankr fee rights to escrow.
    /// @dev This closes the attribution race where rights already in escrow could
    /// otherwise be claimed by an unrelated caller. The seller must still call
    /// Bankr's `updateBeneficiary(poolId, address(this))` after this step.
    /// @param feeManager Bankr fee manager contract for the token pool.
    /// @param poolId Stable Bankr pool identifier for the fee-right position.
    function prepareDeposit(address feeManager, bytes32 poolId) external nonReentrant {
        if (feeManager == address(0)) revert ZeroAddress();
        if (!allowedFeeManager[feeManager]) revert FeeManagerNotAllowed(feeManager);
        if (isEscrowed[poolId]) revert RightsAlreadyEscrowed(poolId);
        if (pendingSeller[poolId] != address(0)) revert DepositAlreadyPending(poolId);

        uint256 sellerShare = IBankrFees(feeManager).getShares(poolId, msg.sender);
        if (sellerShare == 0) revert CallerDoesNotOwnRights(poolId);

        pendingSeller[poolId] = msg.sender;
        pendingFeeManagerForPool[poolId] = feeManager;

        emit DepositPrepared(poolId, feeManager, msg.sender);
    }

    /// @notice Activates escrow after the pre-registered seller transfers Bankr rights here.
    /// @dev Only the seller recorded by `prepareDeposit` can finalize. This
    /// function verifies that escrow owns shares before recording active custody.
    /// @param poolId Stable Bankr pool identifier for the fee-right position.
    function finalizeDeposit(bytes32 poolId) external nonReentrant {
        address seller = pendingSeller[poolId];
        if (seller == address(0)) revert DepositNotPrepared(poolId);
        if (msg.sender != seller) revert UnauthorizedCaller(msg.sender);

        address feeManager = pendingFeeManagerForPool[poolId];
        uint256 escrowShare = IBankrFees(feeManager).getShares(poolId, address(this));
        if (escrowShare == 0) revert EscrowDoesNotOwnRights(poolId);

        originalOwner[poolId] = seller;
        feeManagerForPool[poolId] = feeManager;
        isEscrowed[poolId] = true;
        _clearPendingDeposit(poolId);

        emit RightsDeposited(poolId, feeManager, seller);
    }

    /// @notice Releases escrowed Bankr fee rights to `to`.
    /// @dev Owner-only for this custody proof. Marketplace/NFT authorization is
    /// deliberately left out until custody is proven.
    /// @param poolId Bankr pool whose fee rights should be released.
    /// @param to Recipient that will become the Bankr beneficiary.
    function releaseRights(bytes32 poolId, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        address feeManager = _requireEscrowed(poolId);
        IBankrFees(feeManager).updateBeneficiary(poolId, to);
        _verifyTransferred(poolId, feeManager, to);
        _clearEscrow(poolId);

        emit RightsReleased(poolId, feeManager, to);
    }

    /// @notice Returns escrowed Bankr fee rights to the original seller.
    /// @dev Allows either the seller or contract owner to cancel during this PoC.
    /// @param poolId Bankr pool whose fee rights should be returned.
    function cancelRights(bytes32 poolId) external nonReentrant {
        address feeManager = _requireEscrowed(poolId);
        address seller = originalOwner[poolId];

        if (msg.sender != seller && msg.sender != owner()) revert UnauthorizedCaller(msg.sender);

        IBankrFees(feeManager).updateBeneficiary(poolId, seller);
        _verifyTransferred(poolId, feeManager, seller);
        _clearEscrow(poolId);

        emit RightsCancelled(poolId, feeManager, seller);
    }

    /// @notice Claims currently available fees while this contract is the beneficiary.
    /// @param poolId Bankr pool whose fees should be claimed.
    /// @return fees0 Amount of token0 fees claimed.
    /// @return fees1 Amount of token1 fees claimed.
    function claimFees(bytes32 poolId) external nonReentrant returns (uint256 fees0, uint256 fees1) {
        address feeManager = _requireEscrowed(poolId);

        (fees0, fees1) = IBankrFees(feeManager).collectFees(poolId);
        accruedFees0[poolId] += fees0;
        accruedFees1[poolId] += fees1;

        emit FeesClaimed(poolId, feeManager, fees0, fees1);
    }

    /// @notice Returns this escrow's current Bankr share allocation for `poolId`.
    /// @param poolId Bankr pool to inspect.
    function getEscrowShare(bytes32 poolId) external view returns (uint256) {
        address feeManager = _requireEscrowed(poolId);
        return IBankrFees(feeManager).getShares(poolId, address(this));
    }

    /// @notice Returns claimable fees based on Bankr's cumulative fee accounting.
    /// @dev Bankr docs note full live claimable also includes uncollected pool
    /// fees surfaced by simulating `collectFees`; this view covers recorded
    /// cumulative accounting and is enough for the custody proof.
    /// @param poolId Bankr pool to inspect.
    /// @return fees0 Estimated claimable token0 fees for the escrow.
    /// @return fees1 Estimated claimable token1 fees for the escrow.
    function getClaimableFees(bytes32 poolId) external view returns (uint256 fees0, uint256 fees1) {
        address feeManager = _requireEscrowed(poolId);
        IBankrFees fees = IBankrFees(feeManager);

        uint256 shares = fees.getShares(poolId, address(this));
        fees0 = ((fees.getCumulatedFees0(poolId) - fees.getLastCumulatedFees0(poolId, address(this))) * shares) / 1e18;
        fees1 = ((fees.getCumulatedFees1(poolId) - fees.getLastCumulatedFees1(poolId, address(this))) * shares) / 1e18;
    }

    /// @dev Loads the fee manager for a registered escrow position.
    function _requireEscrowed(bytes32 poolId) internal view returns (address feeManager) {
        if (!isEscrowed[poolId]) revert RightsNotEscrowed(poolId);
        feeManager = feeManagerForPool[poolId];
    }

    /// @dev Verifies Bankr fee rights left escrow and arrived at the expected beneficiary.
    function _verifyTransferred(bytes32 poolId, address feeManager, address expectedBeneficiary) internal view {
        IBankrFees fees = IBankrFees(feeManager);
        if (fees.getShares(poolId, address(this)) != 0 || fees.getShares(poolId, expectedBeneficiary) == 0) {
            revert TransferVerificationFailed(poolId, expectedBeneficiary);
        }
    }

    /// @dev Clears pending registration after escrow custody is finalized.
    function _clearPendingDeposit(bytes32 poolId) internal {
        delete pendingSeller[poolId];
        delete pendingFeeManagerForPool[poolId];
    }

    /// @dev Clears local escrow state after Bankr accepts the beneficiary transfer.
    function _clearEscrow(bytes32 poolId) internal {
        delete originalOwner[poolId];
        delete feeManagerForPool[poolId];
        delete isEscrowed[poolId];
    }
}
