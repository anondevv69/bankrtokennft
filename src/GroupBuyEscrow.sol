// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IBankrFees} from "./interfaces/IBankrFees.sol";
import {BankrFeeRightsReceipt} from "./BankrFeeRightsReceipt.sol";

// ── 0xSplits V2 minimal interface ────────────────────────────────────────────

/// @dev Struct mirrored from SplitV2Lib.Split — must match exactly.
struct SplitV2Params {
    address[] recipients;
    uint256[] allocations;
    uint256 totalAllocation;
    uint16 distributionIncentive;
}

interface IPushSplitFactory {
    function createSplit(SplitV2Params calldata splitParams, address owner, address creator)
        external
        returns (address split);
}

// ── BankrEscrowV3 minimal interface ──────────────────────────────────────────

interface IBankrEscrowRedeemable {
    function redeemRights(uint256 tokenId) external;
}

// ── GroupBuyEscrow ────────────────────────────────────────────────────────────

/// @title GroupBuyEscrow
/// @notice Timed pooled-purchase and partial-sale escrow for ERC-721 fee-rights NFTs.
///
/// **Group Buy**: multiple contributors pool ETH within a deadline. When fully funded,
/// anyone calls `finalize()` which creates a 0xSplits V2 PushSplit, transfers proportional
/// ownership to every contributor, and directs the underlying Bankr fee stream to the split.
///
/// **Partial Sale**: seller keeps a permanent share in the split (e.g. 80%), contributors
/// fund only the sold portion (e.g. 20%) and share it proportionally. The seller receives
/// the raised ETH minus the platform fee.
///
/// **Bankr TMPR path**: when `bankrEscrow` is non-zero the contract holds the TMPR receipt,
/// calls `BankrEscrowV3.redeemRights(tokenId)` (which burns the NFT and moves Bankr fee
/// shares to this contract), then immediately calls `IBankrFees.updateBeneficiary(poolId,
/// split)` so the split address becomes the direct beneficiary on the Bankr protocol.
///
/// **Generic ERC-721 path**: when `bankrEscrow` is zero the NFT is simply transferred to
/// the split address on finalize.
contract GroupBuyEscrow is ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────────

    /// @notice Platform fee in basis points (200 = 2 %).
    uint256 public constant FEE_BPS = 200;
    uint256 private constant BPS_DENOM = 10_000;

    /// @notice Hard cap on contributors per listing (0xSplits gas limits).
    uint256 public constant MAX_CONTRIBUTORS = 100;

    uint256 public constant MIN_DURATION = 5 minutes;
    uint256 public constant MAX_DURATION = 30 days;

    // ── Immutables ───────────────────────────────────────────────────────────

    /// @notice Vault receiving the 2 % platform cut on every finalized sale.
    address public immutable feeRecipient;

    /// @notice 0xSplits V2 PushSplitFactory on Base mainnet.
    IPushSplitFactory public immutable splitFactory;

    // ── Storage ──────────────────────────────────────────────────────────────

    struct Listing {
        IERC721 collection;
        uint256 tokenId;
        address seller;
        /// @dev ETH contributors must collectively raise (always the buyer-funded portion).
        uint256 priceWei;
        /// @dev Unix timestamp after which refunds become available if not fully funded.
        uint64 deadline;
        uint256 minContributionWei;
        /// @dev > 0 for partial-sale: seller retains this BPS share in the resulting split.
        ///      0 for a standard group buy (all shares go to contributors).
        uint16 sellerKeepsBps;
        /// @dev BankrEscrowV3 address. Non-zero → TMPR redeem path on finalize.
        address bankrEscrow;
        uint256 totalRaised;
        /// @dev Split address written on finalize (0 before finalize).
        address splitAddress;
        bool active;
        bool finalized;
    }

    uint256 private _nextListingId = 1;
    mapping(uint256 listingId => Listing) private _listings;

    mapping(uint256 listingId => address[]) private _contributors;
    mapping(uint256 listingId => mapping(address contributor => uint256 amount)) private _contributions;
    mapping(uint256 listingId => mapping(address contributor => bool added)) private _hasContributed;

    // ── Events ───────────────────────────────────────────────────────────────

    event GroupBuyListed(
        uint256 indexed listingId,
        address indexed collection,
        uint256 indexed tokenId,
        address seller,
        uint256 priceWei,
        uint64 deadline,
        uint16 sellerKeepsBps
    );
    event Contributed(uint256 indexed listingId, address indexed contributor, uint256 amount, uint256 totalRaised);
    event Finalized(uint256 indexed listingId, address indexed splitAddress, uint256 totalRaised);
    event Refunded(uint256 indexed listingId, address indexed contributor, uint256 amount);
    event Cancelled(uint256 indexed listingId, address indexed seller);
    event AccruedFeesForwarded(uint256 indexed listingId, address indexed split, uint256 amount0, uint256 amount1);

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrice();
    error InvalidDuration();
    error InvalidSellerKeepsBps();
    error ListingInactive();
    error AlreadyFinalized();
    error NotFullyFunded();
    error DeadlineNotReached();
    error FullyFunded();
    error NotSeller();
    error TooManyContributors();
    error ContributionTooSmall();
    error SellerCannotContributeInPartialMode();
    error NothingToRefund();
    error HasContributions();
    error NotFinalized();

    // ── Constructor ──────────────────────────────────────────────────────────

    /// @param feeRecipient_  Vault receiving 2 % platform cut.
    /// @param splitFactory_  0xSplits V2 PushSplitFactory address.
    constructor(address feeRecipient_, address splitFactory_) {
        if (feeRecipient_ == address(0) || splitFactory_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        splitFactory = IPushSplitFactory(splitFactory_);
    }

    // ── Listing creation ─────────────────────────────────────────────────────

    /// @notice List a TMPR/ERC-721 for group purchase. All contributors share
    ///         proportionally to their ETH contribution.
    /// @param collection          ERC-721 contract.
    /// @param tokenId             Token to list.
    /// @param priceWei            Total ETH to raise from contributors.
    /// @param durationSeconds     Listing window (MIN_DURATION..MAX_DURATION).
    /// @param minContributionWei  Minimum per contribute() call (0 = no minimum).
    /// @param bankrEscrow         BankrEscrowV3 address, or address(0) for generic ERC-721.
    function createListing(
        IERC721 collection,
        uint256 tokenId,
        uint256 priceWei,
        uint256 durationSeconds,
        uint256 minContributionWei,
        address bankrEscrow
    ) external nonReentrant returns (uint256 listingId) {
        return _createListing(collection, tokenId, priceWei, durationSeconds, minContributionWei, 0, bankrEscrow);
    }

    /// @notice List a TMPR/ERC-721 for partial sale: seller keeps `sellerKeepsBps` of
    ///         future fees forever; contributors fund the sold `(10000 - sellerKeepsBps)` BPS.
    /// @param priceWei        ETH contributors must raise for the sold portion only.
    /// @param sellerKeepsBps  Seller's permanent share (1..9999, in basis points).
    function createPartialListing(
        IERC721 collection,
        uint256 tokenId,
        uint256 priceWei,
        uint256 durationSeconds,
        uint256 minContributionWei,
        uint16 sellerKeepsBps,
        address bankrEscrow
    ) external nonReentrant returns (uint256 listingId) {
        if (sellerKeepsBps == 0 || sellerKeepsBps >= BPS_DENOM) revert InvalidSellerKeepsBps();
        return _createListing(collection, tokenId, priceWei, durationSeconds, minContributionWei, sellerKeepsBps, bankrEscrow);
    }

    // ── Contribute ───────────────────────────────────────────────────────────

    /// @notice Contribute ETH toward the listing. Excess beyond `priceWei` is automatically refunded.
    function contribute(uint256 listingId) external payable nonReentrant {
        Listing storage li = _listings[listingId];
        if (!li.active || li.finalized) revert ListingInactive();
        if (block.timestamp > li.deadline) revert ListingInactive();
        if (msg.value < li.minContributionWei) revert ContributionTooSmall();
        if (li.sellerKeepsBps > 0 && msg.sender == li.seller) revert SellerCannotContributeInPartialMode();

        uint256 remaining = li.priceWei - li.totalRaised;
        uint256 accepted = msg.value > remaining ? remaining : msg.value;
        uint256 dust = msg.value - accepted;

        if (!_hasContributed[listingId][msg.sender]) {
            if (_contributors[listingId].length >= MAX_CONTRIBUTORS) revert TooManyContributors();
            _contributors[listingId].push(msg.sender);
            _hasContributed[listingId][msg.sender] = true;
        }
        _contributions[listingId][msg.sender] += accepted;
        li.totalRaised += accepted;

        if (dust > 0) {
            (bool ok,) = msg.sender.call{value: dust}("");
            require(ok, "refund failed");
        }

        emit Contributed(listingId, msg.sender, accepted, li.totalRaised);
    }

    // ── Finalize ─────────────────────────────────────────────────────────────

    /// @notice Finalize the group buy / partial sale once fully funded.
    ///         Callable by anyone as soon as `totalRaised >= priceWei`.
    ///         Creates the 0xSplits PushSplit, routes fee rights to the split,
    ///         and pays the seller.
    function finalize(uint256 listingId) external nonReentrant {
        Listing storage li = _listings[listingId];
        if (li.finalized) revert AlreadyFinalized();
        if (!li.active) revert ListingInactive();
        if (li.totalRaised < li.priceWei) revert NotFullyFunded();

        li.active = false;
        li.finalized = true;

        address split = _buildAndCreateSplit(listingId, li);
        li.splitAddress = split;

        // For TMPR: read position BEFORE redeemRights burns the NFT.
        if (li.bankrEscrow != address(0)) {
            BankrFeeRightsReceipt.Position memory pos =
                BankrFeeRightsReceipt(address(li.collection)).positionOf(li.tokenId);
            // Step 1: redeemRights — burns NFT, moves Bankr fee shares to address(this).
            IBankrEscrowRedeemable(li.bankrEscrow).redeemRights(li.tokenId);
            // Step 2: updateBeneficiary — moves fee shares from address(this) to split.
            IBankrFees(pos.feeManager).updateBeneficiary(pos.poolId, split);
        } else {
            li.collection.safeTransferFrom(address(this), split, li.tokenId);
        }

        _paySeller(li);

        emit Finalized(listingId, split, li.totalRaised);
    }

    // ── Refunds ──────────────────────────────────────────────────────────────

    /// @notice Trigger refunds for all contributors when the deadline has passed
    ///         without the listing reaching full funding. Returns the NFT to seller.
    ///         Best-effort: failed ETH sends stay claimable via `claimRefund`.
    function refundAll(uint256 listingId) external nonReentrant {
        Listing storage li = _listings[listingId];
        if (!li.active || li.finalized) revert ListingInactive();
        if (block.timestamp <= li.deadline) revert DeadlineNotReached();
        if (li.totalRaised >= li.priceWei) revert FullyFunded();

        li.active = false;

        li.collection.safeTransferFrom(address(this), li.seller, li.tokenId);

        address[] storage contributors = _contributors[listingId];
        for (uint256 i = 0; i < contributors.length; i++) {
            address c = contributors[i];
            uint256 amount = _contributions[listingId][c];
            if (amount == 0) continue;
            _contributions[listingId][c] = 0;
            (bool ok,) = c.call{value: amount}("");
            if (!ok) {
                _contributions[listingId][c] = amount;
            } else {
                emit Refunded(listingId, c, amount);
            }
        }
    }

    /// @notice Individual refund claim for contributors who could not be refunded
    ///         during `refundAll` (e.g. smart contract wallets that rejected the push).
    function claimRefund(uint256 listingId) external nonReentrant {
        Listing storage li = _listings[listingId];
        if (li.active) revert ListingInactive();
        if (li.finalized) revert AlreadyFinalized();
        uint256 amount = _contributions[listingId][msg.sender];
        if (amount == 0) revert NothingToRefund();
        _contributions[listingId][msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit Refunded(listingId, msg.sender, amount);
    }

    /// @notice Cancel a listing with no contributions. Only callable by the seller.
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage li = _listings[listingId];
        if (!li.active || li.finalized) revert ListingInactive();
        if (msg.sender != li.seller) revert NotSeller();
        if (li.totalRaised > 0) revert HasContributions();

        li.active = false;
        li.collection.safeTransferFrom(address(this), li.seller, li.tokenId);
        emit Cancelled(listingId, li.seller);
    }

    // ── Post-finalize: forward pre-accrued fees ───────────────────────────────

    /// @notice For TMPR listings: withdraw any fees that had been claimed into BankrEscrowV3
    ///         before finalize (unlikely but possible) and forward them to the split.
    ///         Callable by anyone after finalize.
    /// @param bankrEscrowAddress  The BankrEscrowV3 contract that held the pool.
    /// @param poolId              Bankr pool identifier.
    /// @param token0              First fee token in the pool.
    /// @param token1              Second fee token in the pool.
    function forwardAccruedFees(
        uint256 listingId,
        address bankrEscrowAddress,
        bytes32 poolId,
        address token0,
        address token1
    ) external nonReentrant {
        Listing storage li = _listings[listingId];
        if (!li.finalized) revert NotFinalized();
        address split = li.splitAddress;

        // withdrawClaimedFees sends tokens to this contract (as feeRecipientForPool).
        (bool ok, bytes memory data) = bankrEscrowAddress.call(
            abi.encodeWithSignature("withdrawClaimedFees(bytes32,address)", poolId, address(this))
        );
        if (!ok || data.length == 0) return; // nothing to withdraw or already withdrawn

        (uint256 fees0, uint256 fees1) = abi.decode(data, (uint256, uint256));
        if (fees0 > 0) IERC20(token0).safeTransfer(split, fees0);
        if (fees1 > 0) IERC20(token1).safeTransfer(split, fees1);

        emit AccruedFeesForwarded(listingId, split, fees0, fees1);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    function getContributors(uint256 listingId) external view returns (address[] memory) {
        return _contributors[listingId];
    }

    function getContribution(uint256 listingId, address contributor) external view returns (uint256) {
        return _contributions[listingId][contributor];
    }

    function nextListingId() external view returns (uint256) {
        return _nextListingId;
    }

    // ── ERC-721 receiver ─────────────────────────────────────────────────────

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    function _createListing(
        IERC721 collection,
        uint256 tokenId,
        uint256 priceWei,
        uint256 durationSeconds,
        uint256 minContributionWei,
        uint16 sellerKeepsBps,
        address bankrEscrow
    ) internal returns (uint256 listingId) {
        if (address(collection) == address(0)) revert ZeroAddress();
        if (priceWei == 0) revert ZeroPrice();
        if (durationSeconds < MIN_DURATION || durationSeconds > MAX_DURATION) revert InvalidDuration();

        listingId = _nextListingId++;
        uint64 deadline = uint64(block.timestamp + durationSeconds);

        _listings[listingId] = Listing({
            collection: collection,
            tokenId: tokenId,
            seller: msg.sender,
            priceWei: priceWei,
            deadline: deadline,
            minContributionWei: minContributionWei,
            sellerKeepsBps: sellerKeepsBps,
            bankrEscrow: bankrEscrow,
            totalRaised: 0,
            splitAddress: address(0),
            active: true,
            finalized: false
        });

        collection.transferFrom(msg.sender, address(this), tokenId);

        emit GroupBuyListed(listingId, address(collection), tokenId, msg.sender, priceWei, deadline, sellerKeepsBps);
    }

    /// @dev Builds the Split params and calls the factory.
    ///      For partial sale: allocations are scaled so seller gets `sellerKeepsBps` and
    ///      contributors share `(BPS_DENOM - sellerKeepsBps)` proportionally.
    ///      For group buy: allocations equal contributions (proportional).
    function _buildAndCreateSplit(uint256 listingId, Listing storage li) internal returns (address split) {
        address[] storage contributors = _contributors[listingId];
        mapping(address => uint256) storage contribs = _contributions[listingId];
        uint256 numContrib = contributors.length;
        bool partialSale = li.sellerKeepsBps > 0;

        uint256 numRecipients = partialSale ? numContrib + 1 : numContrib;
        address[] memory recipients = new address[](numRecipients);
        uint256[] memory allocations = new uint256[](numRecipients);
        uint256 totalAlloc;

        if (partialSale) {
            uint256 soldBps = uint256(BPS_DENOM) - li.sellerKeepsBps;
            uint256 raised = li.totalRaised;
            recipients[0] = li.seller;
            allocations[0] = uint256(li.sellerKeepsBps) * raised;
            totalAlloc = allocations[0];
            for (uint256 i = 0; i < numContrib; i++) {
                address c = contributors[i];
                uint256 alloc = contribs[c] * soldBps;
                recipients[i + 1] = c;
                allocations[i + 1] = alloc;
                totalAlloc += alloc;
            }
        } else {
            for (uint256 i = 0; i < numContrib; i++) {
                address c = contributors[i];
                uint256 alloc = contribs[c];
                recipients[i] = c;
                allocations[i] = alloc;
                totalAlloc += alloc;
            }
        }

        SplitV2Params memory params = SplitV2Params({
            recipients: recipients,
            allocations: allocations,
            totalAllocation: totalAlloc,
            distributionIncentive: 0
        });

        split = splitFactory.createSplit(params, address(0), address(this));
    }

    /// @dev Pay seller: raise - 2% fee.
    function _paySeller(Listing storage li) internal {
        if (li.totalRaised == 0) return;
        (uint256 fee, uint256 sellerProceeds) = _splitFee(li.totalRaised);
        (bool ok,) = li.seller.call{value: sellerProceeds}("");
        require(ok, "ETH to seller failed");
        (bool feePaid,) = feeRecipient.call{value: fee}("");
        require(feePaid, "fee transfer failed");
    }

    function _splitFee(uint256 totalWei) private pure returns (uint256 fee, uint256 sellerProceeds) {
        fee = (totalWei * FEE_BPS) / BPS_DENOM;
        sellerProceeds = totalWei - fee;
    }
}
