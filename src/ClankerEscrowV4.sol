// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IClankerLockerV4} from "./interfaces/IClankerLockerV4.sol";
import {BankrFeeRightsReceipt} from "./BankrFeeRightsReceipt.sol";

/// @title ClankerEscrowV4
/// @notice Escrow for Clanker **v4** LP creator-reward rights on the shared TMPR receipt collection.
///
/// @dev  Clanker v4 lockers (`ClankerLpLockerFeeConversion`, `ClankerLpLocker`) identify rewards by
///       `(address token, uint256 rewardIndex)` rather than `uint256 lpTokenId` (v3.x `LpLockerv2`).
///       There are two roles per index: `rewardAdmin` (controls both roles) and `rewardRecipient`
///       (receives collected fees). Both must be transferred to this escrow before finalize.
///
///       Deposit flow (4 transactions):
///         1. Seller calls `prepareDeposit(locker, token, rewardIndex, token0, token1)`.
///            Caller must be `rewardAdmins[rewardIndex]` for `token` on the locker.
///         2. Seller calls `locker.updateRewardRecipient(token, rewardIndex, <this escrow>)`.
///         3. Seller calls `locker.updateRewardAdmin(token, rewardIndex, <this escrow>)`.
///         4. Seller calls `finalizeDeposit(locker, token, rewardIndex)`.
///            Escrow verifies it is both admin and recipient, then mints the TMPR receipt NFT.
///
///       The TMPR NFT encodes `feeManager = locker` and `poolId = key` (the full keccak key)
///       so the redeem path can reconstruct `(locker, clankerToken, rewardIndex)` from storage.
///
///       Known v4 locker addresses on Base mainnet:
///         ClankerLpLockerFeeConversion: 0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496
///         ClankerLpLocker:              0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0
contract ClankerEscrowV4 is Ownable, ReentrancyGuard {
    /// @notice Shared TMPR receipt collection (also used by BankrEscrowV3 and ClankerEscrowV1).
    BankrFeeRightsReceipt public immutable receipt;

    /// @notice Clanker v4 locker contracts approved for use.
    mapping(address locker => bool) public allowedLocker;

    /// @notice Human-readable factory label for the NFT (e.g. "Clanker v4").
    mapping(address locker => string) public factoryNames;

    // ── State keyed by keccak256(abi.encode(locker, clankerToken, rewardIndex)) ─

    mapping(bytes32 key => address) public pendingSeller;
    mapping(bytes32 key => address) public lockerForKey;
    mapping(bytes32 key => address) public clankerTokenForKey;
    mapping(bytes32 key => uint256) public rewardIndexForKey;
    mapping(bytes32 key => address) public token0ForKey;
    mapping(bytes32 key => address) public token1ForKey;

    mapping(bytes32 key => address) public originalOwner;
    mapping(bytes32 key => bool) public isEscrowed;
    mapping(bytes32 key => bool) public isSettled;
    mapping(bytes32 key => address) public feeRecipientForKey;

    /// @notice Stores the original fee recipient at deposit time so it can be restored on cancel.
    mapping(bytes32 key => address) public originalRecipientForKey;

    // ── Events ────────────────────────────────────────────────────────────────

    event LockerAllowlistUpdated(address indexed locker, bool allowed);
    event DepositPrepared(
        bytes32 indexed key,
        address indexed locker,
        address indexed token,
        uint256 rewardIndex,
        address seller
    );
    event PendingDepositCancelled(bytes32 indexed key, address indexed seller);
    event RightsDeposited(
        bytes32 indexed key,
        address indexed locker,
        address indexed token,
        uint256 rewardIndex,
        address seller
    );
    event RightsReleased(bytes32 indexed key, address indexed to);
    event RightsCancelled(bytes32 indexed key, address indexed to);
    event ReceiptMinted(bytes32 indexed key, uint256 indexed tokenId, address indexed to);

    // ── Errors ────────────────────────────────────────────────────────────────

    error ZeroAddress();
    error DuplicateTokenAddress(address token);
    error LockerNotAllowed(address locker);
    error RightsAlreadyEscrowed(bytes32 key);
    error DepositAlreadyPending(bytes32 key);
    error DepositNotPrepared(bytes32 key);
    error RightsNotEscrowed(bytes32 key);
    error RewardIndexOutOfBounds(bytes32 key, uint256 rewardIndex);
    error CallerIsNotRewardAdmin(bytes32 key, address caller);
    error EscrowNotAdminAndRecipient(bytes32 key);
    error UnauthorizedCaller(address caller);
    error SellerCannotCancelAfterNftTransfer(bytes32 key);

    // ── Constructor ───────────────────────────────────────────────────────────

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

    function setFactoryName(address locker, string calldata name) external onlyOwner {
        if (locker == address(0)) revert ZeroAddress();
        factoryNames[locker] = name;
    }

    // ── Key helpers ───────────────────────────────────────────────────────────

    function keyFor(address locker, address token, uint256 rewardIndex) public pure returns (bytes32) {
        return keccak256(abi.encode(locker, token, rewardIndex));
    }

    /// @notice Deterministic TMPR receipt token ID for a v4 Clanker position.
    function tokenIdFor(address locker, address token, uint256 rewardIndex) public pure returns (uint256) {
        return uint256(keyFor(locker, token, rewardIndex));
    }

    // ── Deposit flow ──────────────────────────────────────────────────────────

    /// @notice Step 1 — register intent to escrow Clanker v4 creator-reward rights.
    ///         Caller must be `rewardAdmins[rewardIndex]` for `token` on the v4 `locker`.
    ///         `token0` / `token1` are the Uniswap pool legs (read from locker's `tokenRewards`).
    ///         After this call the seller must:
    ///           a) `locker.updateRewardRecipient(token, rewardIndex, <this escrow>)`
    ///           b) `locker.updateRewardAdmin(token, rewardIndex, <this escrow>)`
    ///         then call `finalizeDeposit`.
    function prepareDeposit(
        address locker,
        address token,
        uint256 rewardIndex,
        address token0,
        address token1
    ) external nonReentrant {
        if (locker == address(0) || token == address(0) || token0 == address(0) || token1 == address(0)) {
            revert ZeroAddress();
        }
        if (token0 == token1) revert DuplicateTokenAddress(token0);
        if (!allowedLocker[locker]) revert LockerNotAllowed(locker);

        bytes32 key = keyFor(locker, token, rewardIndex);
        if (isEscrowed[key]) revert RightsAlreadyEscrowed(key);
        if (pendingSeller[key] != address(0)) revert DepositAlreadyPending(key);

        IClankerLockerV4.TokenRewardInfo memory info = IClankerLockerV4(locker).tokenRewards(token);
        if (rewardIndex >= info.rewardAdmins.length) revert RewardIndexOutOfBounds(key, rewardIndex);
        if (info.rewardAdmins[rewardIndex] != msg.sender) revert CallerIsNotRewardAdmin(key, msg.sender);

        pendingSeller[key] = msg.sender;
        lockerForKey[key] = locker;
        clankerTokenForKey[key] = token;
        rewardIndexForKey[key] = rewardIndex;
        token0ForKey[key] = token0;
        token1ForKey[key] = token1;
        // Store original recipient so cancelPendingDeposit can restore it.
        originalRecipientForKey[key] = info.rewardRecipients[rewardIndex];

        emit DepositPrepared(key, locker, token, rewardIndex, msg.sender);
    }

    /// @notice Step 4 — finalize after the seller has transferred both admin and recipient roles.
    ///         Verifies escrow holds both roles, then mints the TMPR receipt NFT to the seller.
    function finalizeDeposit(address locker, address token, uint256 rewardIndex)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        bytes32 key = keyFor(locker, token, rewardIndex);
        address seller = pendingSeller[key];
        if (seller == address(0)) revert DepositNotPrepared(key);
        if (msg.sender != seller) revert UnauthorizedCaller(msg.sender);

        IClankerLockerV4.TokenRewardInfo memory info = IClankerLockerV4(locker).tokenRewards(token);
        if (rewardIndex >= info.rewardAdmins.length) revert RewardIndexOutOfBounds(key, rewardIndex);

        bool isAdmin = info.rewardAdmins[rewardIndex] == address(this);
        bool isRecipient = info.rewardRecipients[rewardIndex] == address(this);
        if (!isAdmin || !isRecipient) revert EscrowNotAdminAndRecipient(key);

        // Read token pair before clearing pending state.
        address t0 = token0ForKey[key];
        address t1 = token1ForKey[key];

        originalOwner[key] = seller;
        isEscrowed[key] = true;
        // lockerForKey / clankerTokenForKey / rewardIndexForKey are NOT cleared here —
        // they are needed by redeemRights / releaseRights / cancelRights.
        _clearPendingDeposit(key);

        tokenId = tokenIdFor(locker, token, rewardIndex);
        string memory fact = bytes(factoryNames[locker]).length > 0 ? factoryNames[locker] : "Clanker";
        BankrFeeRightsReceipt.Position memory position = BankrFeeRightsReceipt.Position({
            feeManager: locker,
            poolId: key,
            token0: t0,
            token1: t1,
            seller: seller,
            factoryName: fact
        });
        receipt.mint(seller, tokenId, position);

        emit RightsDeposited(key, locker, token, rewardIndex, seller);
        emit ReceiptMinted(key, tokenId, seller);
    }

    /// @notice Cancel a pending (not yet finalized) deposit.
    ///         If the escrow already holds admin or recipient rights on the locker,
    ///         they are restored: admin → seller, recipient → original recipient recorded at prepare time.
    function cancelPendingDeposit(address locker, address token, uint256 rewardIndex) external nonReentrant {
        bytes32 key = keyFor(locker, token, rewardIndex);
        address seller = pendingSeller[key];
        if (seller == address(0)) revert DepositNotPrepared(key);
        if (msg.sender != seller) revert UnauthorizedCaller(msg.sender);

        // Restore locker roles where possible.
        // `updateRewardRecipient` can only be called by the current admin.
        // So restore recipient FIRST (while escrow is still admin), then restore admin.
        IClankerLockerV4.TokenRewardInfo memory info = IClankerLockerV4(locker).tokenRewards(token);
        address originalRecipient = originalRecipientForKey[key];
        if (originalRecipient == address(0)) originalRecipient = seller;
        bool escrowIsAdmin = rewardIndex < info.rewardAdmins.length && info.rewardAdmins[rewardIndex] == address(this);
        bool escrowIsRecipient = rewardIndex < info.rewardRecipients.length && info.rewardRecipients[rewardIndex] == address(this);
        if (escrowIsAdmin && escrowIsRecipient) {
            // Fully transferred — restore recipient first, then hand admin back to seller.
            IClankerLockerV4(locker).updateRewardRecipient(token, rewardIndex, originalRecipient);
            IClankerLockerV4(locker).updateRewardAdmin(token, rewardIndex, seller);
        } else if (escrowIsAdmin) {
            // Only admin was transferred — restore admin; seller can fix recipient themselves.
            IClankerLockerV4(locker).updateRewardAdmin(token, rewardIndex, seller);
        }
        // If escrow is recipient but not admin: escrow cannot call updateRewardRecipient.
        // Seller is still admin and must manually call updateRewardRecipient to fix.

        // Clean up all position fields since finalize will never be called.
        delete lockerForKey[key];
        delete clankerTokenForKey[key];
        delete rewardIndexForKey[key];
        _clearPendingDeposit(key);
        emit PendingDepositCancelled(key, seller);
    }

    /// @notice Owner-only emergency restore for a stuck pending deposit where the escrow
    ///         acquired locker roles but the deposit was never finalized or cancelled normally.
    ///         Restores admin → seller, recipient → original recipient, and clears escrow state.
    function emergencyRestorePendingDeposit(
        address locker,
        address token,
        uint256 rewardIndex
    ) external onlyOwner nonReentrant {
        bytes32 key = keyFor(locker, token, rewardIndex);
        address seller = pendingSeller[key];
        if (seller == address(0)) revert DepositNotPrepared(key);

        IClankerLockerV4.TokenRewardInfo memory info = IClankerLockerV4(locker).tokenRewards(token);
        address originalRecipient = originalRecipientForKey[key];
        if (originalRecipient == address(0)) originalRecipient = seller;
        bool escrowIsAdminE = rewardIndex < info.rewardAdmins.length && info.rewardAdmins[rewardIndex] == address(this);
        bool escrowIsRecipientE = rewardIndex < info.rewardRecipients.length && info.rewardRecipients[rewardIndex] == address(this);
        if (escrowIsAdminE && escrowIsRecipientE) {
            IClankerLockerV4(locker).updateRewardRecipient(token, rewardIndex, originalRecipient);
            IClankerLockerV4(locker).updateRewardAdmin(token, rewardIndex, seller);
        } else if (escrowIsAdminE) {
            IClankerLockerV4(locker).updateRewardAdmin(token, rewardIndex, seller);
        }

        delete lockerForKey[key];
        delete clankerTokenForKey[key];
        delete rewardIndexForKey[key];
        _clearPendingDeposit(key);
        emit PendingDepositCancelled(key, seller);
    }

    // ── Rights transfer ───────────────────────────────────────────────────────

    /// @notice Receipt holder redeems: transfers both admin and recipient rights to the holder,
    ///         burns the receipt NFT.
    function redeemRights(uint256 tokenId) external nonReentrant {
        address holder = receipt.ownerOf(tokenId);
        if (msg.sender != holder) revert UnauthorizedCaller(msg.sender);

        BankrFeeRightsReceipt.Position memory p = receipt.positionOf(tokenId);
        bytes32 key = p.poolId;
        if (!isEscrowed[key]) revert RightsNotEscrowed(key);

        address locker = lockerForKey[key];
        address token = clankerTokenForKey[key];
        uint256 rewardIndex = rewardIndexForKey[key];

        IClankerLockerV4(locker).updateRewardRecipient(token, rewardIndex, msg.sender);
        IClankerLockerV4(locker).updateRewardAdmin(token, rewardIndex, msg.sender);

        receipt.burn(tokenId);
        _settleEscrow(key, msg.sender);

        emit RightsReleased(key, msg.sender);
    }

    /// @notice Emergency release by owner — bypasses receipt-holder check.
    function releaseRights(address locker, address token, uint256 rewardIndex, address to)
        external
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        bytes32 key = keyFor(locker, token, rewardIndex);
        if (!isEscrowed[key]) revert RightsNotEscrowed(key);

        uint256 tokenId = tokenIdFor(locker, token, rewardIndex);
        IClankerLockerV4(locker).updateRewardRecipient(token, rewardIndex, to);
        IClankerLockerV4(locker).updateRewardAdmin(token, rewardIndex, to);
        receipt.burn(tokenId);
        _settleEscrow(key, to);

        emit RightsReleased(key, to);
    }

    /// @notice Returns rights to original seller. Seller may only cancel while still holding receipt.
    ///         Owner may cancel at any time.
    function cancelRights(address locker, address token, uint256 rewardIndex) external nonReentrant {
        bytes32 key = keyFor(locker, token, rewardIndex);
        if (!isEscrowed[key]) revert RightsNotEscrowed(key);
        address seller = originalOwner[key];
        uint256 tokenId = tokenIdFor(locker, token, rewardIndex);

        if (msg.sender == owner()) {
            // admin may always cancel
        } else if (msg.sender == seller) {
            if (receipt.ownerOf(tokenId) != seller) revert SellerCannotCancelAfterNftTransfer(key);
        } else {
            revert UnauthorizedCaller(msg.sender);
        }

        IClankerLockerV4(locker).updateRewardRecipient(token, rewardIndex, seller);
        IClankerLockerV4(locker).updateRewardAdmin(token, rewardIndex, seller);
        receipt.burn(tokenId);
        _settleEscrow(key, seller);

        emit RightsCancelled(key, seller);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    function _settleEscrow(bytes32 key, address feeRecipient) internal {
        isEscrowed[key] = false;
        isSettled[key] = true;
        feeRecipientForKey[key] = feeRecipient;
        // Clean up escrowed position data now that it is settled.
        delete lockerForKey[key];
        delete clankerTokenForKey[key];
        delete rewardIndexForKey[key];
    }

    function _clearPendingDeposit(bytes32 key) internal {
        // Only clear the pending marker and per-deposit token pair.
        // lockerForKey / clankerTokenForKey / rewardIndexForKey are intentionally kept:
        // they become the escrowed position record read by redeemRights / releaseRights / cancelRights.
        // originalRecipientForKey is cleared separately by callers (cancel clears it immediately;
        // finalize doesn't need it after this point).
        delete pendingSeller[key];
        delete token0ForKey[key];
        delete token1ForKey[key];
        delete originalRecipientForKey[key];
    }
}
