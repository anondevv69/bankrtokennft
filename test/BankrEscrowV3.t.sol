// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "openzeppelin-contracts/contracts/interfaces/draft-IERC6093.sol";
import {BankrEscrowV3} from "../src/BankrEscrowV3.sol";
import {BankrFeeRightsReceipt} from "../src/BankrFeeRightsReceipt.sol";
import {MockERC20, MockBankrFeesManagerV2} from "./MockBankrFeesV2.sol";

contract BankrEscrowV3Test is Test {
    uint256 private constant FULL_SHARE = 1e18;

    bytes32 private constant POOL_ID = keccak256("BANKR_POOL_V3");
    address private constant ADMIN = address(0xA11CE);
    address private constant SELLER = address(0x5E11E2);
    address private constant BUYER = address(0xB0B);
    address private constant ATTACKER = address(0xBAD);

    BankrEscrowV3 private escrow;
    MockBankrFeesManagerV2 private feesManager;
    MockERC20 private token0;
    MockERC20 private token1;

    function setUp() public {
        token0 = new MockERC20("Wrapped Ether", "WETH");
        token1 = new MockERC20("Bankr Test Token", "BNKR");
        feesManager = new MockBankrFeesManagerV2(token0, token1);
        escrow = new BankrEscrowV3(ADMIN);

        feesManager.seedBeneficiary(POOL_ID, SELLER, FULL_SHARE);

        vm.prank(ADMIN);
        escrow.setFeeManagerAllowed(address(feesManager), true);
    }

    function testFinalizeMintsReceiptToSeller() public {
        uint256 tokenId = escrow.tokenIdFor(address(feesManager), POOL_ID);

        _prepareAndTransfer();
        vm.prank(SELLER);
        uint256 returnedId = escrow.finalizeDeposit(POOL_ID);

        assertEq(returnedId, tokenId);
        assertEq(escrow.receipt().ownerOf(tokenId), SELLER);
        BankrFeeRightsReceipt.Position memory p = escrow.receipt().positionOf(tokenId);
        assertEq(p.feeManager, address(feesManager));
        assertEq(p.poolId, POOL_ID);
        assertEq(p.token0, address(token0));
        assertEq(p.token1, address(token1));
        assertEq(p.seller, SELLER);
    }

    function testRedeemAfterNftTransferWithdrawsFeesToBuyer() public {
        _escrowWithReceipt();

        feesManager.accrueFees(POOL_ID, 4 ether, 1 ether, 40 ether, 10 ether);
        escrow.claimFees(POOL_ID);

        uint256 tokenId = escrow.tokenIdFor(address(feesManager), POOL_ID);

        vm.startPrank(SELLER);
        escrow.receipt().transferFrom(SELLER, BUYER, tokenId);
        vm.stopPrank();
        assertEq(escrow.receipt().ownerOf(tokenId), BUYER);

        vm.prank(BUYER);
        escrow.redeemRights(tokenId);

        assertEq(feesManager.getShares(POOL_ID, BUYER), FULL_SHARE);
        assertEq(feesManager.getShares(POOL_ID, address(escrow)), 0);
        assertFalse(escrow.isEscrowed(POOL_ID));
        assertEq(escrow.feeRecipientForPool(POOL_ID), BUYER);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        this.assertReceiptMissing(tokenId);

        vm.prank(BUYER);
        escrow.withdrawClaimedFees(POOL_ID, BUYER);

        assertEq(token0.balanceOf(BUYER), 4 ether);
        assertEq(token1.balanceOf(BUYER), 1 ether);
    }

    function testSellerCannotCancelAfterNftTransferred() public {
        _escrowWithReceipt();

        uint256 tokenId = escrow.tokenIdFor(address(feesManager), POOL_ID);

        vm.startPrank(SELLER);
        escrow.receipt().transferFrom(SELLER, BUYER, tokenId);
        vm.stopPrank();

        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowV3.SellerCannotCancelAfterNftTransfer.selector, POOL_ID));
        escrow.cancelRights(POOL_ID);
    }

    function testSellerCanCancelWhileHoldingReceipt() public {
        _escrowWithReceipt();

        vm.prank(SELLER);
        escrow.cancelRights(POOL_ID);

        assertEq(feesManager.getShares(POOL_ID, SELLER), FULL_SHARE);
        assertFalse(escrow.isEscrowed(POOL_ID));
    }

    function testNonOwnerCannotRedeem() public {
        _escrowWithReceipt();
        uint256 tokenId = escrow.tokenIdFor(address(feesManager), POOL_ID);

        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowV3.UnauthorizedCaller.selector, ATTACKER));
        escrow.redeemRights(tokenId);
    }

    function _prepareAndTransfer() private {
        vm.prank(SELLER);
        escrow.prepareDeposit(address(feesManager), POOL_ID, address(token0), address(token1));

        vm.prank(SELLER);
        feesManager.updateBeneficiary(POOL_ID, address(escrow));
    }

    function _escrowWithReceipt() private {
        _prepareAndTransfer();
        vm.prank(SELLER);
        escrow.finalizeDeposit(POOL_ID);
    }

    /// @dev External so Forge can expect a revert (direct view reads do not always satisfy `expectRevert`).
    function assertReceiptMissing(uint256 tokenId) external {
        escrow.receipt().ownerOf(tokenId);
    }
}
