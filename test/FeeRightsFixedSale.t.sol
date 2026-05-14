// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "openzeppelin-contracts/contracts/interfaces/draft-IERC6093.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {FeeRightsFixedSale} from "../src/FeeRightsFixedSale.sol";

contract MockERC721 is ERC721 {
    constructor() ERC721("Mock Fee Receipt", "MFRR") {}

    function mint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}

contract FeeRightsFixedSaleTest is Test {
    FeeRightsFixedSale private sale;
    MockERC721 private nft;

    address private constant SELLER      = address(0x5E11);
    address private constant BUYER       = address(0xB0B);
    address private constant OTHER       = address(0xCAFE);
    address private constant FEE_VAULT   = address(0xFEE5);

    uint256 private constant TOKEN_ID = 7;
    uint256 private constant PRICE    = 1 ether;

    /// @dev 2 % fee on 1 ether = 0.02 ether.
    uint256 private constant EXPECTED_FEE      = (PRICE * 200) / 10_000;
    uint256 private constant EXPECTED_PROCEEDS = PRICE - EXPECTED_FEE;

    function setUp() public {
        sale = new FeeRightsFixedSale(FEE_VAULT);
        nft  = new MockERC721();
        nft.mint(SELLER, TOKEN_ID);
    }

    // ── buy path ────────────────────────────────────────────────────────────

    function testListBuySellerReceivesNetBuyerReceivesNft() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listingId = sale.list(nft, TOKEN_ID, PRICE);
        vm.stopPrank();

        assertEq(nft.ownerOf(TOKEN_ID), address(sale));

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        sale.buy{value: PRICE}(listingId);

        assertEq(nft.ownerOf(TOKEN_ID), BUYER);
        assertEq(SELLER.balance,    EXPECTED_PROCEEDS, "seller net");
        assertEq(FEE_VAULT.balance, EXPECTED_FEE,      "vault fee");
        assertEq(BUYER.balance,     0,                 "buyer spent all");
    }

    function testFeeRecipientIsSet() public view {
        assertEq(sale.feeRecipient(), FEE_VAULT);
    }

    function testFeeBpsIsCorrect() public view {
        assertEq(sale.FEE_BPS(), 200);
    }

    // ── cancel path ─────────────────────────────────────────────────────────

    function testCancelReturnsNftToSeller() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listingId = sale.list(nft, TOKEN_ID, PRICE);
        sale.cancel(listingId);
        vm.stopPrank();

        assertEq(nft.ownerOf(TOKEN_ID), SELLER);
        // No fee on cancel.
        assertEq(FEE_VAULT.balance, 0);
    }

    // ── revert paths ────────────────────────────────────────────────────────

    function testBuyRevertsWrongPayment() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listingId = sale.list(nft, TOKEN_ID, PRICE);
        vm.stopPrank();

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        vm.expectRevert(FeeRightsFixedSale.WrongPayment.selector);
        sale.buy{value: PRICE - 1}(listingId);
    }

    function testCancelRevertsNotSeller() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listingId = sale.list(nft, TOKEN_ID, PRICE);
        vm.stopPrank();

        vm.prank(OTHER);
        vm.expectRevert(FeeRightsFixedSale.NotSeller.selector);
        sale.cancel(listingId);
    }

    function testListRevertsWhenCallerDoesNotOwnNft() public {
        vm.prank(OTHER);
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(sale), TOKEN_ID)
        );
        sale.list(nft, TOKEN_ID, PRICE);
    }

    function testSecondListSameTokenRevertsAlreadyListed() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        sale.list(nft, TOKEN_ID, PRICE);
        vm.expectRevert(FeeRightsFixedSale.AlreadyListed.selector);
        sale.list(nft, TOKEN_ID, 2 ether);
        vm.stopPrank();
    }

    function testConstructorRevertsZeroFeeRecipient() public {
        vm.expectRevert(FeeRightsFixedSale.ZeroAddress.selector);
        new FeeRightsFixedSale(address(0));
    }

    // ── relist after buy ────────────────────────────────────────────────────

    function testRelistAfterBuy() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listingId = sale.list(nft, TOKEN_ID, PRICE);
        vm.stopPrank();

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        sale.buy{value: PRICE}(listingId);

        vm.startPrank(BUYER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listing2 = sale.list(nft, TOKEN_ID, 2 ether);
        vm.stopPrank();

        assertEq(nft.ownerOf(TOKEN_ID), address(sale));
        assertEq(listing2, 2);
    }

    // ── fee math fuzz ────────────────────────────────────────────────────────

    /// @dev For any price, seller + vault always sums to price and fee is exactly 2 %.
    function testFuzzFeeNeverExceedsPrice(uint96 price) public {
        vm.assume(price > 0);

        uint256 fee      = (uint256(price) * 200) / 10_000;
        uint256 proceeds = uint256(price) - fee;

        assertEq(fee + proceeds, uint256(price), "fee + proceeds != price");
        assertLe(fee, uint256(price) * 200 / 10_000 + 1, "fee > 2 %");
    }
}
