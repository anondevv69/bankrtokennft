// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IBankrFees} from "./interfaces/IBankrFees.sol";
import {BankrFeeRightsReceipt} from "./BankrFeeRightsReceipt.sol";

/// @title BankrEscrowV3
/// @notice Escrow V2 fee accounting plus an ERC721 receipt minted on finalize.
/// @dev Receipt owner may `redeemRights` to receive Bankr fee rights. Seller may
/// `cancelRights` only while they still hold the receipt. Admin `releaseRights`
/// remains as an emergency override. Anyone may call `claimFees` while escrowed.
contract BankrEscrowV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Receipt collection minted/burned by this escrow.
    BankrFeeRightsReceipt public immutable receipt;

    mapping(address feeManager => bool allowed) public allowedFeeManager;

    mapping(bytes32 poolId => address seller) public pendingSeller;
    mapping(bytes32 poolId => address feeManager) public pendingFeeManagerForPool;
    mapping(bytes32 poolId => address token0) public pendingToken0ForPool;
    mapping(bytes32 poolId => address token1) public pendingToken1ForPool;

    mapping(bytes32 poolId => address seller) public originalOwner;
    mapping(bytes32 poolId => address feeManager) public feeManagerForPool;
    mapping(bytes32 poolId => address token0) public token0ForPool;
    mapping(bytes32 poolId => address token1) public token1ForPool;

    mapping(bytes32 poolId => bool escrowed) public isEscrowed;
    mapping(bytes32 poolId => bool settled) public isSettled;
    mapping(bytes32 poolId => address recipient) public feeRecipientForPool;

    mapping(bytes32 poolId => uint256 amount) public accruedFees0;
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
    event ReceiptMinted(bytes32 indexed poolId, uint256 indexed tokenId, address indexed to);

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
    error InvalidReceiptPosition(bytes32 poolId);
    error SellerCannotCancelAfterNftTransfer(bytes32 poolId);

    constructor(address initialOwner) Ownable(initialOwner) {
        receipt = new BankrFeeRightsReceipt(address(this));
    }

    /// @notice Deterministic receipt id for a fee manager and pool.
    function tokenIdFor(address feeManager, bytes32 poolId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(feeManager, poolId)));
    }

    function setFeeManagerAllowed(address feeManager, bool allowed) external onlyOwner {
        if (feeManager == address(0)) revert ZeroAddress();

        allowedFeeManager[feeManager] = allowed;

        emit FeeManagerAllowlistUpdated(feeManager, allowed);
    }

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

    /// @notice Activates escrow and mints the fee-rights receipt to the seller.
    function finalizeDeposit(bytes32 poolId) external nonReentrant returns (uint256 tokenId) {
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

        tokenId = tokenIdFor(feeManager, poolId);
        BankrFeeRightsReceipt.Position memory position = BankrFeeRightsReceipt.Position({
            feeManager: feeManager,
            poolId: poolId,
            token0: token0ForPool[poolId],
            token1: token1ForPool[poolId],
            seller: seller
        });
        receipt.mint(seller, tokenId, position);

        emit RightsDeposited(poolId, feeManager, seller);
        emit ReceiptMinted(poolId, tokenId, seller);
    }

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

    /// @notice Admin-only release (emergency / testnet). Prefer `redeemRights` for normal exits.
    function releaseRights(bytes32 poolId, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        address feeManager = _requireEscrowed(poolId);
        uint256 tokenId = tokenIdFor(feeManager, poolId);
        IBankrFees(feeManager).updateBeneficiary(poolId, to);
        _verifyTransferred(poolId, feeManager, to);
        receipt.burn(tokenId);
        _settleEscrow(poolId, to);

        emit RightsReleased(poolId, feeManager, to);
    }

    /// @notice Current receipt holder receives Bankr fee rights; receipt burns; fees settle to holder.
    function redeemRights(uint256 tokenId) external nonReentrant {
        address holder = receipt.ownerOf(tokenId);
        BankrFeeRightsReceipt.Position memory p = receipt.positionOf(tokenId);
        if (p.feeManager == address(0)) revert InvalidReceiptPosition(p.poolId);

        address feeManager = _requireEscrowed(p.poolId);
        if (feeManager != p.feeManager) revert InvalidReceiptPosition(p.poolId);
        if (originalOwner[p.poolId] != p.seller) revert InvalidReceiptPosition(p.poolId);

        if (msg.sender != holder) revert UnauthorizedCaller(msg.sender);

        IBankrFees(feeManager).updateBeneficiary(p.poolId, msg.sender);
        _verifyTransferred(p.poolId, feeManager, msg.sender);
        receipt.burn(tokenId);
        _settleEscrow(p.poolId, msg.sender);

        emit RightsReleased(p.poolId, feeManager, msg.sender);
    }

    /// @notice Returns rights to the original seller. Seller may only cancel while they still hold the receipt.
    function cancelRights(bytes32 poolId) external nonReentrant {
        address feeManager = _requireEscrowed(poolId);
        address seller = originalOwner[poolId];
        uint256 tokenId = tokenIdFor(feeManager, poolId);

        if (msg.sender == owner()) {
            // Admin may cancel regardless of receipt location.
        } else if (msg.sender == seller) {
            if (receipt.ownerOf(tokenId) != seller) revert SellerCannotCancelAfterNftTransfer(poolId);
        } else {
            revert UnauthorizedCaller(msg.sender);
        }

        IBankrFees(feeManager).updateBeneficiary(poolId, seller);
        _verifyTransferred(poolId, feeManager, seller);
        receipt.burn(tokenId);
        _settleEscrow(poolId, seller);

        emit RightsCancelled(poolId, feeManager, seller);
    }

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

    function getEscrowShare(bytes32 poolId) external view returns (uint256) {
        address feeManager = _requireEscrowed(poolId);
        return IBankrFees(feeManager).getShares(poolId, address(this));
    }

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
