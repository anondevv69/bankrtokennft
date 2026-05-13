// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BankrEscrowV2} from "../src/BankrEscrowV2.sol";
import {MockERC20, MockBankrFeesManagerV2} from "./MockBankrFeesV2.sol";

contract BankrEscrowV2Test is Test {
    uint256 private constant FULL_SHARE = 1e18;
    uint256 private constant PARTIAL_SHARE = 6e17;

    bytes32 private constant POOL_ID = keccak256("BANKR_POOL_V2");
    bytes32 private constant PARTIAL_POOL_ID = keccak256("BANKR_PARTIAL_POOL_V2");
    address private constant ADMIN = address(0xA11CE);
    address private constant SELLER = address(0x5E11E2);
    address private constant BUYER = address(0xB0B);
    address private constant ATTACKER = address(0xBAD);

    BankrEscrowV2 private escrow;
    MockBankrFeesManagerV2 private feesManager;
    MockERC20 private token0;
    MockERC20 private token1;

    function setUp() public {
        token0 = new MockERC20("Wrapped Ether", "WETH");
        token1 = new MockERC20("Bankr Test Token", "BNKR");
        feesManager = new MockBankrFeesManagerV2(token0, token1);
        escrow = new BankrEscrowV2(ADMIN);

        feesManager.seedBeneficiary(POOL_ID, SELLER, FULL_SHARE);
        feesManager.seedBeneficiary(PARTIAL_POOL_ID, SELLER, PARTIAL_SHARE);

        vm.prank(ADMIN);
        escrow.setFeeManagerAllowed(address(feesManager), true);
    }

    function testPrepareFinalizeStoresTokenMetadata() public {
        _escrowRights(POOL_ID);

        assertEq(escrow.originalOwner(POOL_ID), SELLER);
        assertEq(escrow.feeManagerForPool(POOL_ID), address(feesManager));
        assertEq(escrow.token0ForPool(POOL_ID), address(token0));
        assertEq(escrow.token1ForPool(POOL_ID), address(token1));
        assertEq(escrow.getEscrowShare(POOL_ID), FULL_SHARE);
        assertTrue(escrow.isEscrowed(POOL_ID));
    }

    function testClaimUsesActualBalanceDeltasWhenCollectFeesReturnsWrongValues() public {
        _escrowRights(POOL_ID);
        feesManager.accrueFees(POOL_ID, 9 ether, 2 ether, 10 ether, 100 ether);

        (uint256 fees0, uint256 fees1) = escrow.claimFees(POOL_ID);

        assertEq(fees0, 9 ether);
        assertEq(fees1, 2 ether);
        assertEq(escrow.accruedFees0(POOL_ID), 9 ether);
        assertEq(escrow.accruedFees1(POOL_ID), 2 ether);
        assertEq(token0.balanceOf(address(escrow)), 9 ether);
        assertEq(token1.balanceOf(address(escrow)), 2 ether);
    }

    function testMultipleClaimsAccumulateActualDeltas() public {
        _escrowRights(POOL_ID);

        feesManager.accrueFees(POOL_ID, 1 ether, 2 ether, 100 ether, 200 ether);
        (uint256 first0, uint256 first1) = escrow.claimFees(POOL_ID);

        feesManager.accrueFees(POOL_ID, 3 ether, 4 ether, 300 ether, 400 ether);
        (uint256 second0, uint256 second1) = escrow.claimFees(POOL_ID);

        assertEq(first0, 1 ether);
        assertEq(first1, 2 ether);
        assertEq(second0, 3 ether);
        assertEq(second1, 4 ether);
        assertEq(escrow.accruedFees0(POOL_ID), 4 ether);
        assertEq(escrow.accruedFees1(POOL_ID), 6 ether);
        assertEq(token0.balanceOf(address(escrow)), 4 ether);
        assertEq(token1.balanceOf(address(escrow)), 6 ether);
    }

    function testPartialShareAccountingUsesActualDeltas() public {
        _escrowRights(PARTIAL_POOL_ID);
        feesManager.accrueFees(PARTIAL_POOL_ID, 10 ether, 20 ether, 100 ether, 200 ether);

        (uint256 fees0, uint256 fees1) = escrow.claimFees(PARTIAL_POOL_ID);

        assertEq(fees0, 6 ether);
        assertEq(fees1, 12 ether);
        assertEq(escrow.accruedFees0(PARTIAL_POOL_ID), 6 ether);
        assertEq(escrow.accruedFees1(PARTIAL_POOL_ID), 12 ether);
    }

    function testCancelSettlesFeesToSellerAndAllowsWithdrawal() public {
        _escrowRights(POOL_ID);
        feesManager.accrueFees(POOL_ID, 9 ether, 2 ether, 10 ether, 100 ether);
        escrow.claimFees(POOL_ID);

        vm.prank(SELLER);
        escrow.cancelRights(POOL_ID);

        assertEq(escrow.feeRecipientForPool(POOL_ID), SELLER);
        assertTrue(escrow.isSettled(POOL_ID));

        vm.prank(SELLER);
        (uint256 withdrawn0, uint256 withdrawn1) = escrow.withdrawClaimedFees(POOL_ID, SELLER);

        assertEq(withdrawn0, 9 ether);
        assertEq(withdrawn1, 2 ether);
        assertEq(token0.balanceOf(SELLER), 9 ether);
        assertEq(token1.balanceOf(SELLER), 2 ether);
        assertEq(escrow.accruedFees0(POOL_ID), 0);
        assertEq(escrow.accruedFees1(POOL_ID), 0);
    }

    function testReleaseSettlesFeesToBuyerAndAllowsWithdrawal() public {
        _escrowRights(POOL_ID);
        feesManager.accrueFees(POOL_ID, 5 ether, 7 ether, 500 ether, 700 ether);
        escrow.claimFees(POOL_ID);

        vm.prank(ADMIN);
        escrow.releaseRights(POOL_ID, BUYER);

        assertEq(escrow.feeRecipientForPool(POOL_ID), BUYER);
        assertTrue(escrow.isSettled(POOL_ID));

        vm.prank(BUYER);
        (uint256 withdrawn0, uint256 withdrawn1) = escrow.withdrawClaimedFees(POOL_ID, BUYER);

        assertEq(withdrawn0, 5 ether);
        assertEq(withdrawn1, 7 ether);
        assertEq(token0.balanceOf(BUYER), 5 ether);
        assertEq(token1.balanceOf(BUYER), 7 ether);
    }

    function testWithdrawalRejectsWrongRecipient() public {
        _escrowRights(POOL_ID);
        feesManager.accrueFees(POOL_ID, 1 ether, 0, 10 ether, 0);
        escrow.claimFees(POOL_ID);

        vm.prank(SELLER);
        escrow.cancelRights(POOL_ID);

        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowV2.InvalidFeeRecipient.selector, ATTACKER));
        escrow.withdrawClaimedFees(POOL_ID, ATTACKER);
    }

    function testWithdrawalRejectsBeforeRightsAreSettled() public {
        _escrowRights(POOL_ID);
        feesManager.accrueFees(POOL_ID, 1 ether, 0, 10 ether, 0);
        escrow.claimFees(POOL_ID);

        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowV2.FeesNotWithdrawable.selector, POOL_ID));
        escrow.withdrawClaimedFees(POOL_ID, SELLER);
    }

    function testCannotPrepareWithDuplicateTokenAddresses() public {
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowV2.DuplicateTokenAddress.selector, address(token0)));
        escrow.prepareDeposit(address(feesManager), POOL_ID, address(token0), address(token0));
    }

    function testCannotRepreparePoolWithUnwithdrawnFees() public {
        _escrowRights(POOL_ID);
        feesManager.accrueFees(POOL_ID, 1 ether, 0, 10 ether, 0);
        escrow.claimFees(POOL_ID);

        vm.prank(SELLER);
        escrow.cancelRights(POOL_ID);

        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowV2.UnwithdrawnFees.selector, POOL_ID));
        escrow.prepareDeposit(address(feesManager), POOL_ID, address(token0), address(token1));
    }

    function _escrowRights(bytes32 poolId) private {
        vm.prank(SELLER);
        escrow.prepareDeposit(address(feesManager), poolId, address(token0), address(token1));

        vm.prank(SELLER);
        feesManager.updateBeneficiary(poolId, address(escrow));

        vm.prank(SELLER);
        escrow.finalizeDeposit(poolId);
    }
}
