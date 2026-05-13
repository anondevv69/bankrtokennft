// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {FeeRightsFixedSale} from "../src/FeeRightsFixedSale.sol";

contract MockERC721Offers is ERC721 {
    constructor() ERC721("Mock", "M") {}

    function mint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}

contract FeeRightsOffersTest is Test {
    FeeRightsFixedSale private sale;
    MockERC721Offers private nft;

    address private constant SELLER = address(0x5E11);
    address private constant BIDDER = address(0xB1D);
    address private constant BIDDER2 = address(0xB2D);
    address private constant OTHER = address(0xCAFE);

    uint256 private constant TOKEN_ID = 42;

    function setUp() public {
        sale = new FeeRightsFixedSale();
        nft = new MockERC721Offers();
        nft.mint(SELLER, TOKEN_ID);
    }

    function testPlaceOfferWithoutListingIncreasesTotal() public {
        vm.deal(BIDDER, 3 ether);
        vm.prank(BIDDER);
        sale.placeOffer{value: 1 ether}(nft, TOKEN_ID);

        assertEq(sale.offerWei(address(nft), TOKEN_ID, BIDDER), 1 ether);
        assertEq(sale.totalOfferWei(address(nft), TOKEN_ID), 1 ether);

        vm.prank(BIDDER);
        sale.placeOffer{value: 0.5 ether}(nft, TOKEN_ID);

        assertEq(sale.offerWei(address(nft), TOKEN_ID, BIDDER), 1.5 ether);
        assertEq(sale.totalOfferWei(address(nft), TOKEN_ID), 1.5 ether);
    }

    function testWithdrawOfferRefunds() public {
        vm.deal(BIDDER, 1 ether);
        vm.prank(BIDDER);
        sale.placeOffer{value: 1 ether}(nft, TOKEN_ID);

        vm.prank(BIDDER);
        sale.withdrawOffer(nft, TOKEN_ID);

        assertEq(BIDDER.balance, 1 ether);
        assertEq(sale.offerWei(address(nft), TOKEN_ID, BIDDER), 0);
        assertEq(sale.totalOfferWei(address(nft), TOKEN_ID), 0);
    }

    function testAcceptOfferTransfersNftAndEth() public {
        vm.deal(BIDDER, 2 ether);
        vm.prank(BIDDER);
        sale.placeOffer{value: 2 ether}(nft, TOKEN_ID);

        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        sale.acceptOffer(nft, TOKEN_ID, BIDDER);
        vm.stopPrank();

        assertEq(nft.ownerOf(TOKEN_ID), BIDDER);
        assertEq(SELLER.balance, 2 ether);
        assertEq(sale.offerWei(address(nft), TOKEN_ID, BIDDER), 0);
        assertEq(sale.totalOfferWei(address(nft), TOKEN_ID), 0);
    }

    function testPlaceOfferRevertsWhileFixedListingActive() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        sale.list(nft, TOKEN_ID, 1 ether);
        vm.stopPrank();

        vm.deal(BIDDER, 1 ether);
        vm.prank(BIDDER);
        vm.expectRevert(FeeRightsFixedSale.ListedNoOffersWhileActive.selector);
        sale.placeOffer{value: 1 ether}(nft, TOKEN_ID);
    }

    function testBidderCanWithdrawAfterSellerLists() public {
        vm.deal(BIDDER, 1 ether);
        vm.prank(BIDDER);
        sale.placeOffer{value: 1 ether}(nft, TOKEN_ID);

        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        sale.list(nft, TOKEN_ID, 5 ether);
        vm.stopPrank();

        vm.prank(BIDDER);
        sale.withdrawOffer(nft, TOKEN_ID);
        assertEq(BIDDER.balance, 1 ether);
    }

    function testAcceptOfferRevertsIfNotOwnerNorApproved() public {
        vm.deal(BIDDER, 1 ether);
        vm.prank(BIDDER);
        sale.placeOffer{value: 1 ether}(nft, TOKEN_ID);

        vm.prank(OTHER);
        vm.expectRevert(FeeRightsFixedSale.NotAuthorizedForToken.selector);
        sale.acceptOffer(nft, TOKEN_ID, BIDDER);
    }

    function testPlaceOfferZeroEthReverts() public {
        vm.prank(BIDDER);
        vm.expectRevert(FeeRightsFixedSale.ZeroPrice.selector);
        sale.placeOffer{value: 0}(nft, TOKEN_ID);
    }

    function testTwoBiddersIndependentTotals() public {
        vm.deal(BIDDER, 1 ether);
        vm.deal(BIDDER2, 2 ether);
        vm.prank(BIDDER);
        sale.placeOffer{value: 1 ether}(nft, TOKEN_ID);
        vm.prank(BIDDER2);
        sale.placeOffer{value: 2 ether}(nft, TOKEN_ID);

        assertEq(sale.totalOfferWei(address(nft), TOKEN_ID), 3 ether);

        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        sale.acceptOffer(nft, TOKEN_ID, BIDDER);
        vm.stopPrank();

        assertEq(sale.totalOfferWei(address(nft), TOKEN_ID), 2 ether);
        assertEq(nft.ownerOf(TOKEN_ID), BIDDER);

        vm.prank(BIDDER2);
        sale.withdrawOffer(nft, TOKEN_ID);
        assertEq(sale.totalOfferWei(address(nft), TOKEN_ID), 0);
    }
}
