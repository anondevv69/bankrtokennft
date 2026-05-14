// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title FeeRightsFixedSale
/// @notice Fixed-price listings plus optional ETH offers on any ERC721 id (e.g. Bankr receipts not yet listed).
/// @dev List path: custody NFT while listed; `cancel` / `buy` as before. Offer path: bidders lock ETH; owner (or
///      ERC721-approved operator) calls `acceptOffer`. A 2 % platform fee (200 bps) on every `buy` and
///      `acceptOffer` is forwarded to `feeRecipient` (vault wallet set at deploy time).
///      Does not import Bankr escrow or fee managers — only `IERC721`. New offers are blocked while the same asset
///      has an active fixed listing (use `buy`/`cancel` first).
contract FeeRightsFixedSale is ReentrancyGuard {
    // ── Fee config ──────────────────────────────────────────────────────────
    /// @notice Destination for the 2 % platform cut on every sale.
    address public immutable feeRecipient;

    /// @notice Platform fee in basis points (200 = 2 %).
    uint256 public constant FEE_BPS = 200;

    uint256 private constant BPS_DENOM = 10_000;

    // ── Listing storage ─────────────────────────────────────────────────────
    struct Listing {
        IERC721 collection;
        uint256 tokenId;
        address seller;
        uint256 priceWei;
        bool active;
    }

    uint256 private _nextListingId = 1;
    mapping(uint256 listingId => Listing) private _listings;

    /// @notice Prevents two concurrent listings for the same asset.
    mapping(bytes32 assetKey => uint256 listingId) private _listingIdByAsset;

    /// @notice ETH locked per bidder for an unsolicited offer on `collection` / `tokenId`.
    mapping(address collection => mapping(uint256 tokenId => mapping(address bidder => uint256 weiLocked))) private
        _offerWei;

    /// @notice Sum of standing-offer ETH on this asset (aggregate bid liquidity; per-bidder amounts via `offerWei`).
    mapping(address collection => mapping(uint256 tokenId => uint256 totalWei)) private _totalOfferWeiByAsset;

    // ── Events ───────────────────────────────────────────────────────────────
    event Listed(
        uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 priceWei
    );
    event SaleCancelled(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller);
    event Sold(
        uint256 indexed listingId,
        address indexed collection,
        uint256 indexed tokenId,
        address seller,
        address buyer,
        uint256 priceWei,
        uint256 platformFee
    );

    event OfferPlaced(address indexed collection, uint256 indexed tokenId, address indexed bidder, uint256 totalWei);
    event OfferWithdrawn(
        address indexed collection, uint256 indexed tokenId, address indexed bidder, uint256 withdrawnWei
    );
    event OfferAccepted(
        address indexed collection,
        uint256 indexed tokenId,
        address indexed seller,
        address bidder,
        uint256 priceWei,
        uint256 platformFee
    );

    // ── Errors ───────────────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroPrice();
    error NotSeller();
    error ListingInactive();
    error WrongPayment();
    error AlreadyListed();
    error NoOffer();
    error NotAuthorizedForToken();
    error ListedNoOffersWhileActive();

    // ── Constructor ──────────────────────────────────────────────────────────
    /// @param feeRecipient_ Vault wallet that receives the 2 % platform cut.
    constructor(address feeRecipient_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
    }

    // ── Views ────────────────────────────────────────────────────────────────
    function nextListingId() external view returns (uint256) {
        return _nextListingId;
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return _listings[listingId];
    }

    /// @notice ETH a `bidder` has committed as an offer on `tokenId` of `collection` (0 if none).
    function offerWei(address collection, uint256 tokenId, address bidder) external view returns (uint256) {
        return _offerWei[collection][tokenId][bidder];
    }

    /// @notice Total ETH locked in all open offers on this `collection` / `tokenId` (0 if none).
    function totalOfferWei(address collection, uint256 tokenId) external view returns (uint256) {
        return _totalOfferWeiByAsset[collection][tokenId];
    }

    // ── Offer path ───────────────────────────────────────────────────────────

    /// @notice Adds `msg.value` to the caller's standing offer on `tokenId` (no listing required).
    function placeOffer(IERC721 collection, uint256 tokenId) external payable nonReentrant {
        if (address(collection) == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroPrice();
        if (_hasActiveListing(collection, tokenId)) revert ListedNoOffersWhileActive();

        address c = address(collection);
        uint256 total = _offerWei[c][tokenId][msg.sender] + msg.value;
        _offerWei[c][tokenId][msg.sender] = total;
        _totalOfferWeiByAsset[c][tokenId] += msg.value;

        emit OfferPlaced(c, tokenId, msg.sender, total);
    }

    /// @notice Refunds the caller's full offer on this asset.
    function withdrawOffer(IERC721 collection, uint256 tokenId) external nonReentrant {
        if (address(collection) == address(0)) revert ZeroAddress();

        address c = address(collection);
        uint256 amount = _offerWei[c][tokenId][msg.sender];
        if (amount == 0) revert NoOffer();

        delete _offerWei[c][tokenId][msg.sender];
        _totalOfferWeiByAsset[c][tokenId] -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit OfferWithdrawn(c, tokenId, msg.sender, amount);
    }

    /// @notice Token owner (or ERC721-approved operator) sells to `bidder` for their locked offer amount.
    ///         2 % of the offer goes to `feeRecipient`; remainder to the seller.
    function acceptOffer(IERC721 collection, uint256 tokenId, address bidder) external nonReentrant {
        if (address(collection) == address(0)) revert ZeroAddress();
        if (bidder == address(0)) revert ZeroAddress();
        if (_hasActiveListing(collection, tokenId)) revert ListedNoOffersWhileActive();

        address seller = collection.ownerOf(tokenId);
        if (!_canOperate(collection, msg.sender, seller, tokenId)) revert NotAuthorizedForToken();

        address c = address(collection);
        uint256 priceWei = _offerWei[c][tokenId][bidder];
        if (priceWei == 0) revert NoOffer();

        delete _offerWei[c][tokenId][bidder];
        _totalOfferWeiByAsset[c][tokenId] -= priceWei;

        (uint256 fee, uint256 sellerProceeds) = _splitFee(priceWei);

        (bool paid,) = seller.call{value: sellerProceeds}("");
        require(paid, "ETH transfer failed");

        (bool feePaid,) = feeRecipient.call{value: fee}("");
        require(feePaid, "Fee transfer failed");

        collection.safeTransferFrom(seller, bidder, tokenId);

        emit OfferAccepted(c, tokenId, seller, bidder, priceWei, fee);
    }

    // ── Fixed-price listing path ─────────────────────────────────────────────

    /// @notice Lists `tokenId` of `collection` for `priceWei` (exact ETH on buy). Caller must own the NFT and
    ///         approve this contract.
    function list(IERC721 collection, uint256 tokenId, uint256 priceWei)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        if (address(collection) == address(0)) revert ZeroAddress();
        if (priceWei == 0) revert ZeroPrice();
        if (_hasActiveListing(collection, tokenId)) revert AlreadyListed();

        bytes32 assetKey = keccak256(abi.encode(address(collection), tokenId));

        listingId = _nextListingId++;
        _listingIdByAsset[assetKey] = listingId;

        _listings[listingId] =
            Listing({collection: collection, tokenId: tokenId, seller: msg.sender, priceWei: priceWei, active: true});

        collection.transferFrom(msg.sender, address(this), tokenId);

        emit Listed(listingId, address(collection), tokenId, msg.sender, priceWei);
    }

    /// @notice Cancels a listing and returns the NFT to the seller (no fee on cancel).
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage li = _listings[listingId];
        if (!li.active) revert ListingInactive();
        if (msg.sender != li.seller) revert NotSeller();

        IERC721 collection = li.collection;
        uint256 tokenId = li.tokenId;
        address seller = li.seller;

        _clearListing(listingId, li);

        collection.safeTransferFrom(address(this), seller, tokenId);

        emit SaleCancelled(listingId, address(collection), tokenId, seller);
    }

    /// @notice Buys the listed NFT for exactly `priceWei` ETH.
    ///         2 % of `msg.value` goes to `feeRecipient`; remainder to the seller.
    function buy(uint256 listingId) external payable nonReentrant {
        Listing storage li = _listings[listingId];
        if (!li.active) revert ListingInactive();
        if (msg.value != li.priceWei) revert WrongPayment();

        address seller = li.seller;
        IERC721 collection = li.collection;
        uint256 tokenId = li.tokenId;
        uint256 priceWei = li.priceWei;

        _clearListing(listingId, li);

        (uint256 fee, uint256 sellerProceeds) = _splitFee(priceWei);

        (bool ok,) = seller.call{value: sellerProceeds}("");
        require(ok, "ETH transfer failed");

        (bool feePaid,) = feeRecipient.call{value: fee}("");
        require(feePaid, "Fee transfer failed");

        collection.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Sold(listingId, address(collection), tokenId, seller, msg.sender, priceWei, fee);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// @dev Returns (platformFee, sellerProceeds) for a given total. Fee rounds down.
    function _splitFee(uint256 totalWei) private pure returns (uint256 fee, uint256 sellerProceeds) {
        fee = (totalWei * FEE_BPS) / BPS_DENOM;
        sellerProceeds = totalWei - fee;
    }

    function _clearListing(uint256 listingId, Listing storage li) private {
        bytes32 assetKey = keccak256(abi.encode(address(li.collection), li.tokenId));
        delete _listingIdByAsset[assetKey];
        delete _listings[listingId];
    }

    function _hasActiveListing(IERC721 collection, uint256 tokenId) private view returns (bool) {
        uint256 listingId = _listingIdByAsset[keccak256(abi.encode(address(collection), tokenId))];
        if (listingId == 0) return false;
        return _listings[listingId].active;
    }

    function _canOperate(IERC721 collection, address operator, address owner, uint256 tokenId)
        private
        view
        returns (bool)
    {
        return operator == owner || collection.isApprovedForAll(owner, operator)
            || collection.getApproved(tokenId) == operator;
    }
}
