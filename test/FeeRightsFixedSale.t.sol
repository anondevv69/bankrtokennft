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

    address private constant SELLER = address(0x5E11);
    address private constant BUYER = address(0xB0B);
    address private constant OTHER = address(0xCAFE);

    uint256 private constant TOKEN_ID = 7;
    uint256 private constant PRICE = 1 ether;

    function setUp() public {
        sale = new FeeRightsFixedSale();
        nft = new MockERC721();
        nft.mint(SELLER, TOKEN_ID);
    }

    function testListBuySellerReceivesEthBuyerReceivesNft() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listingId = sale.list(nft, TOKEN_ID, PRICE);
        vm.stopPrank();

        assertEq(nft.ownerOf(TOKEN_ID), address(sale));

        vm.deal(BUYER, PRICE);
        vm.prank(BUYER);
        sale.buy{value: PRICE}(listingId);

        assertEq(nft.ownerOf(TOKEN_ID), BUYER);
        assertEq(SELLER.balance, PRICE);
        assertEq(BUYER.balance, 0);
    }

    function testCancelReturnsNftToSeller() public {
        vm.startPrank(SELLER);
        nft.setApprovalForAll(address(sale), true);
        uint256 listingId = sale.list(nft, TOKEN_ID, PRICE);
        sale.cancel(listingId);
        vm.stopPrank();

        assertEq(nft.ownerOf(TOKEN_ID), SELLER);
    }

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

    /// @dev Cannot list a token the caller does not control (OZ: marketplace not approved by actual owner).
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
}
