// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IBankrFees} from "./interfaces/IBankrFees.sol";

/// @title BankrEscrowV2
/// @notice Custody proof of concept with deterministic fee accounting.
/// @dev This version tracks token addresses per pool and accounts for fees by
/// actual ERC20 balance deltas rather than trusting external return values.
contract BankrEscrowV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Fee managers approved for escrow registration.
    mapping(address feeManager => bool allowed) public allowedFeeManager;

    /// @notice Seller that pre-registered a deposit before transferring rights to escrow.
    mapping(bytes32 poolId => address seller) public pendingSeller;

    /// @notice Fee manager attached to a pre-registered deposit.
    mapping(bytes32 poolId => address feeManager) public pendingFeeManagerForPool;

    /// @notice Token0 attached to a pre-registered deposit.
    mapping(bytes32 poolId => address token0) public pendingToken0ForPool;

    /// @notice Token1 attached to a pre-registered deposit.
    mapping(bytes32 poolId => address token1) public pendingToken1ForPool;

    /// @notice Original seller for each escrowed Bankr pool.
    mapping(bytes32 poolId => address seller) public originalOwner;

    /// @notice Bankr fee manager address for each pool.
    mapping(bytes32 poolId => address feeManager) public feeManagerForPool;

    /// @notice Token0 fee asset for each pool.
    mapping(bytes32 poolId => address token0) public token0ForPool;

    /// @notice Token1 fee asset for each pool.
    mapping(bytes32 poolId => address token1) public token1ForPool;

    /// @notice True when a pool's Bankr fee rights are registered in escrow.
    mapping(bytes32 poolId => bool escrowed) public isEscrowed;

    /// @notice True after rights have been canceled or released and fees can be withdrawn.
    mapping(bytes32 poolId => bool settled) public isSettled;

    /// @notice Recipient entitled to fees claimed while rights were escrowed.
    mapping(bytes32 poolId => address recipient) public feeRecipientForPool;

    /// @notice Actual token0 fees received by escrow and not yet withdrawn.
    mapping(bytes32 poolId => uint256 amount) public accruedFees0;

    /// @notice Actual token1 fees received by escrow and not yet withdrawn.
    mapping(bytes32 poolId => uint256 amount) public accruedFees1;

    event FeeManagerAllowlistUpdated(address indexed feeManager, bool allowed);
    event DepositPrepared(
        bytes32 indexed poolId, address indexed feeManager, address indexed seller, address token0, address token1
    );
    event PendingDepositCancelled(bytes32 indexed poolId, address indexed seller);
    event RightsDeposited(bytes32 indexed poolId, address indexed feeManager, address indexed originalOwner);
    event RightsReleased(bytes32 indexed poolId, address indexed feeManager, address indexed to);
    event RightsCancelled(bytes32 indexed poolId, address indexed feeManager, address indexed originalOwner);
    event FeesClaimed(bytes32 indexed poolId, address indexed feeManager, uint256 fees0, uint256 fees1);
    event FeesWithdrawn(bytes32 indexed poolId, address indexed recipient, uint256 fees0, uint256 fees1);

    error ZeroAddress();
    error DuplicateTokenAddress(address token);
    error RightsAlreadyEscrowed(bytes32 poolId);
    error DepositAlreadyPending(bytes32 poolId);
    error DepositNotPrepared(bytes32 poolId);
    error RightsNotEscrowed(bytes32 poolId);
    error EscrowDoesNotOwnRights(bytes32 poolId);
    error EscrowAlreadyOwnsRights(bytes32 poolId);
    error CallerDoesNotOwnRights(bytes32 poolId);
    error FeeManagerNotAllowed(address feeManager);
    error TransferVerificationFailed(bytes32 poolId, address expectedBeneficiary);
    error UnauthorizedCaller(address caller);
    error FeesNotWithdrawable(bytes32 poolId);
    error InvalidFeeRecipient(address recipient);
    error NoClaimedFees(bytes32 poolId);
    error UnwithdrawnFees(bytes32 poolId);

    /// @param initialOwner Admin address allowed to release rights in this proof of concept.
    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Allows or blocks a Bankr fee manager for escrow deposits.
    function setFeeManagerAllowed(address feeManager, bool allowed) external onlyOwner {
        if (feeManager == address(0)) revert ZeroAddress();

        allowedFeeManager[feeManager] = allowed;

        emit FeeManagerAllowlistUpdated(feeManager, allowed);
    }

    /// @notice Pre-registers a seller before they transfer Bankr fee rights to escrow.
    /// @param feeManager Bankr fee manager contract for the token pool.
    /// @param poolId Stable Bankr pool identifier for the fee-right position.
    /// @param token0 ERC20 token paid as token0 fees.
    /// @param token1 ERC20 token paid as token1 fees.
    function prepareDeposit(address feeManager, bytes32 poolId, address token0, address token1) external nonReentrant {
        if (feeManager == address(0) || token0 == address(0) || token1 == address(0)) revert ZeroAddress();
        if (token0 == token1) revert DuplicateTokenAddress(token0);
        if (!allowedFeeManager[feeManager]) revert FeeManagerNotAllowed(feeManager);
        if (isEscrowed[poolId]) revert RightsAlreadyEscrowed(poolId);
        if (pendingSeller[poolId] != address(0)) revert DepositAlreadyPending(poolId);
        if (accruedFees0[poolId] != 0 || accruedFees1[poolId] != 0) revert UnwithdrawnFees(poolId);

        uint256 sellerShare = IBankrFees(feeManager).getShares(poolId, msg.sender);
        if (sellerShare == 0) revert CallerDoesNotOwnRights(poolId);

        pendingSeller[poolId] = msg.sender;
        pendingFeeManagerForPool[poolId] = feeManager;
        pendingToken0ForPool[poolId] = token0;
        pendingToken1ForPool[poolId] = token1;

        delete isSettled[poolId];
        delete feeRecipientForPool[poolId];

        emit DepositPrepared(poolId, feeManager, msg.sender, token0, token1);
    }

    /// @notice Activates escrow after the pre-registered seller transfers Bankr rights here.
    function finalizeDeposit(bytes32 poolId) external nonReentrant {
        address seller = pendingSeller[poolId];
        if (seller == address(0)) revert DepositNotPrepared(poolId);
        if (msg.sender != seller) revert UnauthorizedCaller(msg.sender);

        address feeManager = pendingFeeManagerForPool[poolId];
        uint256 escrowShare = IBankrFees(feeManager).getShares(poolId, address(this));
        if (escrowShare == 0) revert EscrowDoesNotOwnRights(poolId);

        originalOwner[poolId] = seller;
        feeManagerForPool[poolId] = feeManager;
        token0ForPool[poolId] = pendingToken0ForPool[poolId];
        token1ForPool[poolId] = pendingToken1ForPool[poolId];
        isEscrowed[poolId] = true;
        _clearPendingDeposit(poolId);

        emit RightsDeposited(poolId, feeManager, seller);
    }

    /// @notice Cancels a pending deposit before escrow custody is finalized.
    function cancelPendingDeposit(bytes32 poolId) external nonReentrant {
        address seller = pendingSeller[poolId];
        if (seller == address(0)) revert DepositNotPrepared(poolId);
        if (msg.sender != seller) revert UnauthorizedCaller(msg.sender);

        address feeManager = pendingFeeManagerForPool[poolId];
        uint256 escrowShare = IBankrFees(feeManager).getShares(poolId, address(this));
        if (escrowShare != 0) revert EscrowAlreadyOwnsRights(poolId);

        _clearPendingDeposit(poolId);

        emit PendingDepositCancelled(poolId, seller);
    }

    /// @notice Releases escrowed Bankr fee rights to `to`.
    /// @dev Owner-only for this custody proof. Marketplace/NFT authorization is
    /// deliberately left out until custody and accounting are proven.
    function releaseRights(bytes32 poolId, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        address feeManager = _requireEscrowed(poolId);
        IBankrFees(feeManager).updateBeneficiary(poolId, to);
        _verifyTransferred(poolId, feeManager, to);
        _settleEscrow(poolId, to);

        emit RightsReleased(poolId, feeManager, to);
    }

    /// @notice Returns escrowed Bankr fee rights to the original seller.
    function cancelRights(bytes32 poolId) external nonReentrant {
        address feeManager = _requireEscrowed(poolId);
        address seller = originalOwner[poolId];

        if (msg.sender != seller && msg.sender != owner()) revert UnauthorizedCaller(msg.sender);

        IBankrFees(feeManager).updateBeneficiary(poolId, seller);
        _verifyTransferred(poolId, feeManager, seller);
        _settleEscrow(poolId, seller);

        emit RightsCancelled(poolId, feeManager, seller);
    }

    /// @notice Claims currently available fees while this contract is the beneficiary.
    /// @dev Accounts using actual ERC20 balance deltas, not `collectFees` return values.
    /// @return fees0 Actual token0 amount received by escrow.
    /// @return fees1 Actual token1 amount received by escrow.
    function claimFees(bytes32 poolId) external nonReentrant returns (uint256 fees0, uint256 fees1) {
        address feeManager = _requireEscrowed(poolId);
        IERC20 token0 = IERC20(token0ForPool[poolId]);
        IERC20 token1 = IERC20(token1ForPool[poolId]);

        uint256 balance0Before = token0.balanceOf(address(this));
        uint256 balance1Before = token1.balanceOf(address(this));

        IBankrFees(feeManager).collectFees(poolId);

        fees0 = token0.balanceOf(address(this)) - balance0Before;
        fees1 = token1.balanceOf(address(this)) - balance1Before;
        accruedFees0[poolId] += fees0;
        accruedFees1[poolId] += fees1;

        emit FeesClaimed(poolId, feeManager, fees0, fees1);
    }

    /// @notice Withdraws fees claimed while rights were escrowed to the terminal beneficiary.
    /// @dev After cancel, the terminal beneficiary is the seller. After release,
    /// it is the buyer/recipient.
    function withdrawClaimedFees(bytes32 poolId, address recipient)
        external
        nonReentrant
        returns (uint256 fees0, uint256 fees1)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (!isSettled[poolId]) revert FeesNotWithdrawable(poolId);
        if (recipient != feeRecipientForPool[poolId]) revert InvalidFeeRecipient(recipient);
        if (msg.sender != recipient && msg.sender != owner()) revert UnauthorizedCaller(msg.sender);

        fees0 = accruedFees0[poolId];
        fees1 = accruedFees1[poolId];
        if (fees0 == 0 && fees1 == 0) revert NoClaimedFees(poolId);

        accruedFees0[poolId] = 0;
        accruedFees1[poolId] = 0;

        if (fees0 != 0) IERC20(token0ForPool[poolId]).safeTransfer(recipient, fees0);
        if (fees1 != 0) IERC20(token1ForPool[poolId]).safeTransfer(recipient, fees1);

        emit FeesWithdrawn(poolId, recipient, fees0, fees1);
    }

    /// @notice Returns this escrow's current Bankr share allocation for `poolId`.
    function getEscrowShare(bytes32 poolId) external view returns (uint256) {
        address feeManager = _requireEscrowed(poolId);
        return IBankrFees(feeManager).getShares(poolId, address(this));
    }

    /// @notice Returns claimable fees based on Bankr's cumulative fee accounting.
    /// @dev This remains an estimate and is not used for escrow accounting.
    function getClaimableFees(bytes32 poolId) external view returns (uint256 fees0, uint256 fees1) {
        address feeManager = _requireEscrowed(poolId);
        IBankrFees fees = IBankrFees(feeManager);

        uint256 shares = fees.getShares(poolId, address(this));
        fees0 = ((fees.getCumulatedFees0(poolId) - fees.getLastCumulatedFees0(poolId, address(this))) * shares) / 1e18;
        fees1 = ((fees.getCumulatedFees1(poolId) - fees.getLastCumulatedFees1(poolId, address(this))) * shares) / 1e18;
    }

    function _requireEscrowed(bytes32 poolId) internal view returns (address feeManager) {
        if (!isEscrowed[poolId]) revert RightsNotEscrowed(poolId);
        feeManager = feeManagerForPool[poolId];
    }

    function _verifyTransferred(bytes32 poolId, address feeManager, address expectedBeneficiary) internal view {
        IBankrFees fees = IBankrFees(feeManager);
        if (fees.getShares(poolId, address(this)) != 0 || fees.getShares(poolId, expectedBeneficiary) == 0) {
            revert TransferVerificationFailed(poolId, expectedBeneficiary);
        }
    }

    function _settleEscrow(bytes32 poolId, address feeRecipient) internal {
        isEscrowed[poolId] = false;
        isSettled[poolId] = true;
        feeRecipientForPool[poolId] = feeRecipient;
    }

    function _clearPendingDeposit(bytes32 poolId) internal {
        delete pendingSeller[poolId];
        delete pendingFeeManagerForPool[poolId];
        delete pendingToken0ForPool[poolId];
        delete pendingToken1ForPool[poolId];
    }
}
