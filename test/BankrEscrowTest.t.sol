// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BankrEscrowTest} from "../src/BankrEscrowTest.sol";
import {IBankrFees} from "../src/interfaces/IBankrFees.sol";

/// @notice Local Bankr fee manager double used to prove escrow custody behavior.
contract MockBankrFeesManager is IBankrFees {
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 shares)) private _shares;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastCumulatedFees0)) private _lastCumulatedFees0;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastCumulatedFees1)) private _lastCumulatedFees1;

    mapping(bytes32 poolId => uint256 cumulatedFees0) public cumulatedFees0;
    mapping(bytes32 poolId => uint256 cumulatedFees1) public cumulatedFees1;

    mapping(address beneficiary => uint256 amount) public claimedFees0;
    mapping(address beneficiary => uint256 amount) public claimedFees1;

    bool public noOpTransfers;

    error NotBeneficiary();
    error ZeroAddress();

    function setNoOpTransfers(bool noOpTransfers_) external {
        noOpTransfers = noOpTransfers_;
    }

    function seedBeneficiary(bytes32 poolId, address beneficiary, uint256 shares_) external {
        if (beneficiary == address(0)) revert ZeroAddress();
        _shares[poolId][beneficiary] = shares_;
    }

    function accrueFees(bytes32 poolId, uint256 fees0, uint256 fees1) external {
        cumulatedFees0[poolId] += fees0;
        cumulatedFees1[poolId] += fees1;
    }

    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external {
        if (newBeneficiary == address(0)) revert ZeroAddress();

        uint256 currentShares = _shares[poolId][msg.sender];
        if (currentShares == 0) revert NotBeneficiary();

        if (noOpTransfers) return;

        _shares[poolId][msg.sender] = 0;
        _shares[poolId][newBeneficiary] = currentShares;

        // Carry the previous checkpoint forward so already-claimable fees move
        // with the beneficiary rights, matching the Bankr docs.
        _lastCumulatedFees0[poolId][newBeneficiary] = _lastCumulatedFees0[poolId][msg.sender];
        _lastCumulatedFees1[poolId][newBeneficiary] = _lastCumulatedFees1[poolId][msg.sender];
        delete _lastCumulatedFees0[poolId][msg.sender];
        delete _lastCumulatedFees1[poolId][msg.sender];
    }

    function collectFees(bytes32 poolId) external returns (uint256 fees0, uint256 fees1) {
        uint256 currentShares = _shares[poolId][msg.sender];
        if (currentShares == 0) revert NotBeneficiary();

        fees0 = ((cumulatedFees0[poolId] - _lastCumulatedFees0[poolId][msg.sender]) * currentShares) / 1e18;
        fees1 = ((cumulatedFees1[poolId] - _lastCumulatedFees1[poolId][msg.sender]) * currentShares) / 1e18;

        _lastCumulatedFees0[poolId][msg.sender] = cumulatedFees0[poolId];
        _lastCumulatedFees1[poolId][msg.sender] = cumulatedFees1[poolId];
        claimedFees0[msg.sender] += fees0;
        claimedFees1[msg.sender] += fees1;
    }

    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _shares[poolId][beneficiary];
    }

    function getCumulatedFees0(bytes32 poolId) external view returns (uint256) {
        return cumulatedFees0[poolId];
    }

    function getCumulatedFees1(bytes32 poolId) external view returns (uint256) {
        return cumulatedFees1[poolId];
    }

    function getLastCumulatedFees0(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _lastCumulatedFees0[poolId][beneficiary];
    }

    function getLastCumulatedFees1(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _lastCumulatedFees1[poolId][beneficiary];
    }
}

contract BankrEscrowTestTest is Test {
    uint256 private constant FULL_SHARE = 1e18;

    bytes32 private constant POOL_ID = keccak256("BANKR_POOL");
    address private constant ADMIN = address(0xA11CE);
    address private constant SELLER = address(0x5E11E2);
    address private constant BUYER = address(0xB0B);
    address private constant ATTACKER = address(0xBAD);

    BankrEscrowTest private escrow;
    MockBankrFeesManager private feesManager;

    function setUp() public {
        feesManager = new MockBankrFeesManager();
        escrow = new BankrEscrowTest(ADMIN);

        feesManager.seedBeneficiary(POOL_ID, SELLER, FULL_SHARE);

        vm.prank(ADMIN);
        escrow.setFeeManagerAllowed(address(feesManager), true);
    }

    function testPrepareFinalizeAndReleaseRights() public {
        _escrowRights();

        assertEq(escrow.originalOwner(POOL_ID), SELLER);
        assertEq(escrow.feeManagerForPool(POOL_ID), address(feesManager));
        assertTrue(escrow.isEscrowed(POOL_ID));
        assertEq(escrow.getEscrowShare(POOL_ID), FULL_SHARE);

        vm.prank(ADMIN);
        escrow.releaseRights(POOL_ID, BUYER);

        assertEq(feesManager.getShares(POOL_ID, BUYER), FULL_SHARE);
        assertEq(feesManager.getShares(POOL_ID, address(escrow)), 0);
        assertEq(escrow.originalOwner(POOL_ID), address(0));
        assertEq(escrow.feeManagerForPool(POOL_ID), address(0));
        assertFalse(escrow.isEscrowed(POOL_ID));
    }

    function testClaimFeesWhileEscrowOwnsRights() public {
        _escrowRights();

        feesManager.accrueFees(POOL_ID, 3 ether, 5 ether);

        (uint256 claimable0, uint256 claimable1) = escrow.getClaimableFees(POOL_ID);
        assertEq(claimable0, 3 ether);
        assertEq(claimable1, 5 ether);

        (uint256 claimed0, uint256 claimed1) = escrow.claimFees(POOL_ID);
        assertEq(claimed0, 3 ether);
        assertEq(claimed1, 5 ether);
        assertEq(feesManager.claimedFees0(address(escrow)), 3 ether);
        assertEq(feesManager.claimedFees1(address(escrow)), 5 ether);
        assertEq(escrow.accruedFees0(POOL_ID), 3 ether);
        assertEq(escrow.accruedFees1(POOL_ID), 5 ether);

        (claimable0, claimable1) = escrow.getClaimableFees(POOL_ID);
        assertEq(claimable0, 0);
        assertEq(claimable1, 0);
    }

    function testSellerCancelReturnsRightsAndClearsState() public {
        _escrowRights();

        vm.prank(SELLER);
        escrow.cancelRights(POOL_ID);

        assertEq(feesManager.getShares(POOL_ID, SELLER), FULL_SHARE);
        assertEq(feesManager.getShares(POOL_ID, address(escrow)), 0);
        assertEq(escrow.originalOwner(POOL_ID), address(0));
        assertEq(escrow.feeManagerForPool(POOL_ID), address(0));
        assertFalse(escrow.isEscrowed(POOL_ID));
    }

    function testCannotFinalizeIfEscrowDoesNotOwnRights() public {
        _prepareDeposit();

        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.EscrowDoesNotOwnRights.selector, POOL_ID));
        escrow.finalizeDeposit(POOL_ID);
    }

    function testCannotReleaseUnknownPool() public {
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.RightsNotEscrowed.selector, POOL_ID));
        escrow.releaseRights(POOL_ID, BUYER);
    }

    function testCannotReleaseToZeroAddress() public {
        _escrowRights();

        vm.prank(ADMIN);
        vm.expectRevert(BankrEscrowTest.ZeroAddress.selector);
        escrow.releaseRights(POOL_ID, address(0));
    }

    function testUnauthorizedReleaseIsBlocked() public {
        _escrowRights();

        vm.prank(ATTACKER);
        vm.expectRevert();
        escrow.releaseRights(POOL_ID, BUYER);

        assertEq(feesManager.getShares(POOL_ID, address(escrow)), FULL_SHARE);
        assertEq(feesManager.getShares(POOL_ID, BUYER), 0);
    }

    function testMisattributionAttackCannotFinalize() public {
        _prepareDeposit();
        _transferRightsToEscrow();

        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.UnauthorizedCaller.selector, ATTACKER));
        escrow.finalizeDeposit(POOL_ID);

        assertEq(escrow.originalOwner(POOL_ID), address(0));
        assertFalse(escrow.isEscrowed(POOL_ID));

        vm.prank(SELLER);
        escrow.finalizeDeposit(POOL_ID);

        assertEq(escrow.originalOwner(POOL_ID), SELLER);
        assertTrue(escrow.isEscrowed(POOL_ID));
    }

    function testCannotFinalizeWithoutPreparedDeposit() public {
        _transferRightsToEscrow();

        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.DepositNotPrepared.selector, POOL_ID));
        escrow.finalizeDeposit(POOL_ID);
    }

    function testUnauthorizedFinalizeIsBlocked() public {
        _prepareDeposit();
        _transferRightsToEscrow();

        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.UnauthorizedCaller.selector, ATTACKER));
        escrow.finalizeDeposit(POOL_ID);
    }

    function testRejectsNonAllowlistedFeeManager() public {
        MockBankrFeesManager fakeManager = new MockBankrFeesManager();
        fakeManager.seedBeneficiary(POOL_ID, SELLER, FULL_SHARE);

        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.FeeManagerNotAllowed.selector, address(fakeManager)));
        escrow.prepareDeposit(address(fakeManager), POOL_ID);
    }

    function testPrepareRequiresCallerToOwnRights() public {
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.CallerDoesNotOwnRights.selector, POOL_ID));
        escrow.prepareDeposit(address(feesManager), POOL_ID);
    }

    function testRevertWhenReleaseTransferVerificationFails() public {
        _escrowRights();
        feesManager.setNoOpTransfers(true);

        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.TransferVerificationFailed.selector, POOL_ID, BUYER));
        escrow.releaseRights(POOL_ID, BUYER);

        assertEq(feesManager.getShares(POOL_ID, address(escrow)), FULL_SHARE);
        assertEq(feesManager.getShares(POOL_ID, BUYER), 0);
        assertEq(escrow.originalOwner(POOL_ID), SELLER);
        assertTrue(escrow.isEscrowed(POOL_ID));
    }

    function testRevertWhenCancelTransferVerificationFails() public {
        _escrowRights();
        feesManager.setNoOpTransfers(true);

        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(BankrEscrowTest.TransferVerificationFailed.selector, POOL_ID, SELLER));
        escrow.cancelRights(POOL_ID);

        assertEq(feesManager.getShares(POOL_ID, address(escrow)), FULL_SHARE);
        assertEq(feesManager.getShares(POOL_ID, SELLER), 0);
        assertEq(escrow.originalOwner(POOL_ID), SELLER);
        assertTrue(escrow.isEscrowed(POOL_ID));
    }

    function _escrowRights() private {
        _prepareDeposit();
        _transferRightsToEscrow();
        _finalizeDeposit();
    }

    function _prepareDeposit() private {
        vm.prank(SELLER);
        escrow.prepareDeposit(address(feesManager), POOL_ID);
    }

    function _transferRightsToEscrow() private {
        vm.prank(SELLER);
        feesManager.updateBeneficiary(POOL_ID, address(escrow));
    }

    function _finalizeDeposit() private {
        vm.prank(SELLER);
        escrow.finalizeDeposit(POOL_ID);
    }
}
