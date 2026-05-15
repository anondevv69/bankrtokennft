// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IClankerLocker} from "./interfaces/IClankerLocker.sol";
import {BankrFeeRightsReceipt} from "./BankrFeeRightsReceipt.sol";

/// @title ClankerEscrowV1
/// @notice Escrow that lets sellers list Clanker LP creator-reward rights as TMPR NFTs on the
///         shared `BankrFeeRightsReceipt` collection.
///
/// @dev  Clanker's LpLockerv2 identifies positions by `uint256 lpTokenId` (the Uniswap V3 LP NFT
///       token ID) and separates `admin` rights (who can reassign both roles) from `recipient`
///       rights (who receives fees). This is different from BankrEscrowV3, which uses a Bankr
///       fee-manager contract with `bytes32 poolId` + `getShares` / `updateBeneficiary`.
///
///       Deposit flow:
///         1. Seller calls `prepareDeposit(locker, lpTokenId, token0, token1)`.
///            Caller must be the current `creator.admin` on the LP position.
///         2. Seller calls `locker.updateCreatorRewardAdmin(lpTokenId, escrow)` directly.
///         3. Seller calls `finalizeDeposit(locker, lpTokenId)`.
///            Escrow verifies it is now admin, takes over the recipient role, mints TMPR NFT.
///         4. TMPR NFT is freely tradeable on any ERC-721 marketplace (e.g. OpenSea).
///         5. Buyer calls `redeemRights(receiptTokenId)` to receive admin + recipient rights
///            and burn the receipt.
///
///       The `poolId` field stored in the TMPR Position is `bytes32(lpTokenId)` for display only.
contract ClankerEscrowV1 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Shared TMPR receipt collection (also used by BankrEscrowV3).
    BankrFeeRightsReceipt public immutable receipt;

    /// @notice Clanker LP locker contracts approved for use (LpLockerv2 and future versions).
    mapping(address locker => bool allowed) public allowedLocker;

    /// @notice Human-readable factory label embedded in the NFT. Defaults to "Clanker" if unset.
    mapping(address locker => string) public factoryNames;

    // ── State keyed by keccak256(abi.encode(locker, lpTokenId)) ──────────────

    mapping(bytes32 key => address seller) public pendingSeller;
    mapping(bytes32 key => address locker) public pendingLockerForKey;
    mapping(bytes32 key => uint256) public pendingLpTokenIdForKey;
    mapping(bytes32 key => address token0) public pendingToken0ForKey;
    mapping(bytes32 key => address token1) public pendingToken1ForKey;

    mapping(bytes32 key => address seller) public originalOwner;
    mapping(bytes32 key => address locker) public lockerForKey;
    mapping(bytes32 key => uint256) public lpTokenIdForKey;
    mapping(bytes32 key => address token0) public token0ForKey;
    mapping(bytes32 key => address token1) public token1ForKey;

    mapping(bytes32 key => bool escrowed) public isEscrowed;
    mapping(bytes32 key => bool settled) public isSettled;
    mapping(bytes32 key => address recipient) public feeRecipientForKey;

    mapping(bytes32 key => uint256 amount) public accruedFees0;
    mapping(bytes32 key => uint256 amount) public accruedFees1;

    // ── Events ────────────────────────────────────────────────────────────────

    event LockerAllowlistUpdated(address indexed locker, bool allowed);
    event DepositPrepared(bytes32 indexed key, address indexed locker, uint256 lpTokenId, address indexed seller);
    event PendingDepositCancelled(bytes32 indexed key, address indexed seller);
    event RightsDeposited(
        bytes32 indexed key, address indexed locker, uint256 lpTokenId, address indexed originalOwner
    );
    event RightsReleased(bytes32 indexed key, address indexed locker, uint256 lpTokenId, address indexed to);
    event RightsCancelled(
        bytes32 indexed key, address indexed locker, uint256 lpTokenId, address indexed originalOwner
    );
    event FeesClaimed(bytes32 indexed key, address indexed locker, uint256 lpTokenId, uint256 fees0, uint256 fees1);
    event FeesWithdrawn(bytes32 indexed key, address indexed recipient, uint256 fees0, uint256 fees1);
    event ReceiptMinted(bytes32 indexed key, uint256 indexed tokenId, address indexed to);

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error DuplicateTokenAddress(address token);
    error LockerNotAllowed(address locker);
    error RightsAlreadyEscrowed(bytes32 key);
    error DepositAlreadyPending(bytes32 key);
    error DepositNotPrepared(bytes32 key);
    error RightsNotEscrowed(bytes32 key);
    error CallerIsNotCreatorAdmin(bytes32 key, address caller);
    error EscrowDoesNotHoldAdminRights(bytes32 key);
    error EscrowAlreadyHoldsAdminRights(bytes32 key);
    error UnauthorizedCaller(address caller);
    error FeesNotWithdrawable(bytes32 key);
    error InvalidFeeRecipient(address recipient);
    error NoClaimedFees(bytes32 key);
    error UnwithdrawnFees(bytes32 key);
    error SellerCannotCancelAfterNftTransfer(bytes32 key);

    // ── Constructor ───────────────────────────────────────────────────────────

    /// @param initialOwner  Contract owner / admin.
    /// @param receipt_      Shared TMPR receipt collection (must already authorize this escrow).
    constructor(address initialOwner, BankrFeeRightsReceipt receipt_) Ownable(initialOwner) {
        if (address(receipt_) == address(0)) revert ZeroAddress();
        receipt = receipt_;
    }

    // ── Owner admin ───────────────────────────────────────────────────────────

    function setLockerAllowed(address locker, bool allowed) external onlyOwner {
        if (locker == address(0)) revert ZeroAddress();
        allowedLocker[locker] = allowed;
        emit LockerAllowlistUpdated(locker, allowed);
    }

    /// @notice Sets the factory label written into the NFT SVG (e.g. "Clanker", "Clanker v3.1").
    function setFactoryName(address locker, string calldata name) external onlyOwner {
        if (locker == address(0)) revert ZeroAddress();
        factoryNames[locker] = name;
    }

    // ── Key / tokenId helpers ─────────────────────────────────────────────────

    function keyFor(address locker, uint256 lpTokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(locker, lpTokenId));
    }

    /// @notice Deterministic TMPR receipt token ID for a Clanker position.
    function tokenIdFor(address locker, uint256 lpTokenId) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(locker, lpTokenId)));
    }

    // ── Deposit flow ──────────────────────────────────────────────────────────

    /// @notice Step 1 — register intent to escrow Clanker creator-reward rights.
    ///         Caller must be the current `creator.admin` for `lpTokenId` on `locker`.
    ///         After this call, the seller must call:
    ///           `locker.updateCreatorRewardAdmin(lpTokenId, <this escrow address>)`
    ///         and then call `finalizeDeposit`.
    function prepareDeposit(address locker, uint256 lpTokenId, address token0, address token1)
        external
        nonReentrant
    {
        if (locker == address(0) || token0 == address(0) || token1 == address(0)) revert ZeroAddress();
        if (token0 == token1) revert DuplicateTokenAddress(token0);
        if (!allowedLocker[locker]) revert LockerNotAllowed(locker);

        bytes32 key = keyFor(locker, lpTokenId);
        if (isEscrowed[key]) revert RightsAlreadyEscrowed(key);
        if (pendingSeller[key] != address(0)) revert DepositAlreadyPending(key);
        if (accruedFees0[key] != 0 || accruedFees1[key] != 0) revert UnwithdrawnFees(key);

        (,, IClankerLocker.RewardRecipient memory creator,) = IClankerLocker(locker).tokenRewards(lpTokenId);
        if (creator.admin != msg.sender) revert CallerIsNotCreatorAdmin(key, msg.sender);

        pendingSeller[key] = msg.sender;
        pendingLockerForKey[key] = locker;
        pendingLpTokenIdForKey[key] = lpTokenId;
        pendingToken0ForKey[key] = token0;
        pendingToken1ForKey[key] = token1;

        delete isSettled[key];
        delete feeRecipientForKey[key];

        emit DepositPrepared(key, locker, lpTokenId, msg.sender);
    }

    /// @notice Step 3 — finalize after the seller has transferred creator-admin rights to this escrow.
    ///         Escrow also claims the recipient role so `claimFees` sends proceeds here.
    function finalizeDeposit(address locker, uint256 lpTokenId) external nonReentrant returns (uint256 tokenId) {
        bytes32 key = keyFor(locker, lpTokenId);
        address seller = pendingSeller[key];
        if (seller == address(0)) revert DepositNotPrepared(key);
        if (msg.sender != seller) revert UnauthorizedCaller(msg.sender);

        (,, IClankerLocker.RewardRecipient memory creator,) = IClankerLocker(locker).tokenRewards(lpTokenId);
        if (creator.admin != address(this)) revert EscrowDoesNotHoldAdminRights(key);

        // Take over recipient so collectRewards sends fees to this escrow.
        IClankerLocker(locker).updateCreatorRewardRecipient(lpTokenId, address(this));

        originalOwner[key] = seller;
        lockerForKey[key] = locker;
        lpTokenIdForKey[key] = lpTokenId;
        token0ForKey[key] = pendingToken0ForKey[key];
        token1ForKey[key] = pendingToken1ForKey[key];
        isEscrowed[key] = true;
        _clearPendingDeposit(key);

        tokenId = tokenIdFor(locker, lpTokenId);
        string memory fact = bytes(factoryNames[locker]).length > 0 ? factoryNames[locker] : "Clanker";
        BankrFeeRightsReceipt.Position memory position = BankrFeeRightsReceipt.Position({
            feeManager: locker,
            poolId: bytes32(lpTokenId),
            token0: token0ForKey[key],
            token1: token1ForKey[key],
            seller: seller,
            factoryName: fact
        });
        receipt.mint(seller, tokenId, position);

        emit RightsDeposited(key, locker, lpTokenId, seller);
        emit ReceiptMinted(key, tokenId, seller);
    }

    /// @notice Cancel a pending (not yet finalized) deposit.
    ///         Only allowed while the escrow does NOT yet hold admin rights (i.e. seller hasn't
    ///         called `updateCreatorRewardAdmin` yet).
    function cancelPendingDeposit(address locker, uint256 lpTokenId) external nonReentrant {
        bytes32 key = keyFor(locker, lpTokenId);
        address seller = pendingSeller[key];
        if (seller == address(0)) revert DepositNotPrepared(key);
        if (msg.sender != seller) revert UnauthorizedCaller(msg.sender);

        (,, IClankerLocker.RewardRecipient memory creator,) = IClankerLocker(locker).tokenRewards(lpTokenId);
        if (creator.admin == address(this)) revert EscrowAlreadyHoldsAdminRights(key);

        _clearPendingDeposit(key);
        emit PendingDepositCancelled(key, seller);
    }

    // ── Rights transfer ───────────────────────────────────────────────────────

    /// @notice Current TMPR receipt holder redeems: receives Clanker creator-admin + recipient
    ///         rights, receipt burns, fees settle to holder.
    function redeemRights(uint256 tokenId) external nonReentrant {
        address holder = receipt.ownerOf(tokenId);
        if (msg.sender != holder) revert UnauthorizedCaller(msg.sender);

        BankrFeeRightsReceipt.Position memory p = receipt.positionOf(tokenId);
        bytes32 key = keyFor(p.feeManager, uint256(p.poolId));
        _requireEscrowed(key);

        address locker = lockerForKey[key];
        uint256 lpTokenId = lpTokenIdForKey[key];

        IClankerLocker(locker).updateCreatorRewardRecipient(lpTokenId, msg.sender);
        IClankerLocker(locker).updateCreatorRewardAdmin(lpTokenId, msg.sender);

        receipt.burn(tokenId);
        _settleEscrow(key, msg.sender);

        emit RightsReleased(key, locker, lpTokenId, msg.sender);
    }

    /// @notice Admin-only emergency release (bypasses receipt-holder requirement).
    function releaseRights(address locker, uint256 lpTokenId, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        bytes32 key = keyFor(locker, lpTokenId);
        _requireEscrowed(key);

        uint256 tokenId = tokenIdFor(locker, lpTokenId);
        IClankerLocker(locker).updateCreatorRewardRecipient(lpTokenId, to);
        IClankerLocker(locker).updateCreatorRewardAdmin(lpTokenId, to);
        receipt.burn(tokenId);
        _settleEscrow(key, to);

        emit RightsReleased(key, locker, lpTokenId, to);
    }

    /// @notice Returns rights to the original seller. Seller may only cancel while they still hold
    ///         the receipt. Admin may cancel at any time.
    function cancelRights(address locker, uint256 lpTokenId) external nonReentrant {
        bytes32 key = keyFor(locker, lpTokenId);
        _requireEscrowed(key);
        address seller = originalOwner[key];
        uint256 tokenId = tokenIdFor(locker, lpTokenId);

        if (msg.sender == owner()) {
            // Admin may cancel regardless of receipt location.
        } else if (msg.sender == seller) {
            if (receipt.ownerOf(tokenId) != seller) revert SellerCannotCancelAfterNftTransfer(key);
        } else {
            revert UnauthorizedCaller(msg.sender);
        }

        IClankerLocker(locker).updateCreatorRewardRecipient(lpTokenId, seller);
        IClankerLocker(locker).updateCreatorRewardAdmin(lpTokenId, seller);
        receipt.burn(tokenId);
        _settleEscrow(key, seller);

        emit RightsCancelled(key, locker, lpTokenId, seller);
    }

    // ── Fee management ────────────────────────────────────────────────────────

    /// @notice Triggers Clanker to distribute accrued LP fees to this escrow (current recipient).
    ///         Anyone may call. Fees are tracked for withdrawal after rights are redeemed.
    function claimFees(address locker, uint256 lpTokenId)
        external
        nonReentrant
        returns (uint256 fees0, uint256 fees1)
    {
        bytes32 key = keyFor(locker, lpTokenId);
        _requireEscrowed(key);

        IERC20 tkn0 = IERC20(token0ForKey[key]);
        IERC20 tkn1 = IERC20(token1ForKey[key]);

        uint256 bal0Before = tkn0.balanceOf(address(this));
        uint256 bal1Before = tkn1.balanceOf(address(this));

        IClankerLocker(locker).collectRewards(lpTokenId);

        fees0 = tkn0.balanceOf(address(this)) - bal0Before;
        fees1 = tkn1.balanceOf(address(this)) - bal1Before;
        accruedFees0[key] += fees0;
        accruedFees1[key] += fees1;

        emit FeesClaimed(key, locker, lpTokenId, fees0, fees1);
    }

    /// @notice Withdraw previously claimed fees after rights have been settled.
    function withdrawClaimedFees(address locker, uint256 lpTokenId, address recipient)
        external
        nonReentrant
        returns (uint256 fees0, uint256 fees1)
    {
        if (recipient == address(0)) revert ZeroAddress();
        bytes32 key = keyFor(locker, lpTokenId);
        if (!isSettled[key]) revert FeesNotWithdrawable(key);
        if (recipient != feeRecipientForKey[key]) revert InvalidFeeRecipient(recipient);
        if (msg.sender != recipient && msg.sender != owner()) revert UnauthorizedCaller(msg.sender);

        fees0 = accruedFees0[key];
        fees1 = accruedFees1[key];
        if (fees0 == 0 && fees1 == 0) revert NoClaimedFees(key);

        accruedFees0[key] = 0;
        accruedFees1[key] = 0;

        if (fees0 != 0) IERC20(token0ForKey[key]).safeTransfer(recipient, fees0);
        if (fees1 != 0) IERC20(token1ForKey[key]).safeTransfer(recipient, fees1);

        emit FeesWithdrawn(key, recipient, fees0, fees1);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    function _requireEscrowed(bytes32 key) internal view {
        if (!isEscrowed[key]) revert RightsNotEscrowed(key);
    }

    function _settleEscrow(bytes32 key, address feeRecipient) internal {
        isEscrowed[key] = false;
        isSettled[key] = true;
        feeRecipientForKey[key] = feeRecipient;
    }

    function _clearPendingDeposit(bytes32 key) internal {
        delete pendingSeller[key];
        delete pendingLockerForKey[key];
        delete pendingLpTokenIdForKey[key];
        delete pendingToken0ForKey[key];
        delete pendingToken1ForKey[key];
    }
}
