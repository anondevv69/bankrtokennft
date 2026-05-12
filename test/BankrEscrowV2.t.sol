// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {BankrEscrowV2} from "../src/BankrEscrowV2.sol";
import {IBankrFees} from "../src/interfaces/IBankrFees.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Fee-manager double that can return values different from actual transferred assets.
contract MockBankrFeesManagerV2 is IBankrFees {
    MockERC20 public immutable token0;
    MockERC20 public immutable token1;

    mapping(bytes32 poolId => mapping(address beneficiary => uint256 shares)) private _shares;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastActualFees0)) private _lastActualFees0;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastActualFees1)) private _lastActualFees1;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastReportedFees0)) private _lastReportedFees0;
    mapping(bytes32 poolId => mapping(address beneficiary => uint256 lastReportedFees1)) private _lastReportedFees1;

    mapping(bytes32 poolId => uint256 amount) public actualCumulatedFees0;
    mapping(bytes32 poolId => uint256 amount) public actualCumulatedFees1;
    mapping(bytes32 poolId => uint256 amount) public reportedCumulatedFees0;
    mapping(bytes32 poolId => uint256 amount) public reportedCumulatedFees1;

    bool public noOpTransfers;

    error NotBeneficiary();
    error ZeroAddress();

    constructor(MockERC20 token0_, MockERC20 token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setNoOpTransfers(bool noOpTransfers_) external {
        noOpTransfers = noOpTransfers_;
    }

    function seedBeneficiary(bytes32 poolId, address beneficiary, uint256 shares_) external {
        if (beneficiary == address(0)) revert ZeroAddress();
        _shares[poolId][beneficiary] = shares_;
    }

    function accrueFees(
        bytes32 poolId,
        uint256 actualFees0,
        uint256 actualFees1,
        uint256 reportedFees0,
        uint256 reportedFees1
    ) external {
        actualCumulatedFees0[poolId] += actualFees0;
        actualCumulatedFees1[poolId] += actualFees1;
        reportedCumulatedFees0[poolId] += reportedFees0;
        reportedCumulatedFees1[poolId] += reportedFees1;

        token0.mint(address(this), actualFees0);
        token1.mint(address(this), actualFees1);
    }

    function updateBeneficiary(bytes32 poolId, address newBeneficiary) external {
        if (newBeneficiary == address(0)) revert ZeroAddress();

        uint256 currentShares = _shares[poolId][msg.sender];
        if (currentShares == 0) revert NotBeneficiary();

        if (noOpTransfers) return;

        _shares[poolId][msg.sender] = 0;
        _shares[poolId][newBeneficiary] = currentShares;

        _lastActualFees0[poolId][newBeneficiary] = _lastActualFees0[poolId][msg.sender];
        _lastActualFees1[poolId][newBeneficiary] = _lastActualFees1[poolId][msg.sender];
        _lastReportedFees0[poolId][newBeneficiary] = _lastReportedFees0[poolId][msg.sender];
        _lastReportedFees1[poolId][newBeneficiary] = _lastReportedFees1[poolId][msg.sender];

        delete _lastActualFees0[poolId][msg.sender];
        delete _lastActualFees1[poolId][msg.sender];
        delete _lastReportedFees0[poolId][msg.sender];
        delete _lastReportedFees1[poolId][msg.sender];
    }

    function collectFees(bytes32 poolId) external returns (uint256 fees0, uint256 fees1) {
        uint256 currentShares = _shares[poolId][msg.sender];
        if (currentShares == 0) revert NotBeneficiary();

        uint256 actualFees0 =
            ((actualCumulatedFees0[poolId] - _lastActualFees0[poolId][msg.sender]) * currentShares) / 1e18;
        uint256 actualFees1 =
            ((actualCumulatedFees1[poolId] - _lastActualFees1[poolId][msg.sender]) * currentShares) / 1e18;

        fees0 = ((reportedCumulatedFees0[poolId] - _lastReportedFees0[poolId][msg.sender]) * currentShares) / 1e18;
        fees1 = ((reportedCumulatedFees1[poolId] - _lastReportedFees1[poolId][msg.sender]) * currentShares) / 1e18;

        _lastActualFees0[poolId][msg.sender] = actualCumulatedFees0[poolId];
        _lastActualFees1[poolId][msg.sender] = actualCumulatedFees1[poolId];
        _lastReportedFees0[poolId][msg.sender] = reportedCumulatedFees0[poolId];
        _lastReportedFees1[poolId][msg.sender] = reportedCumulatedFees1[poolId];

        if (actualFees0 != 0) token0.transfer(msg.sender, actualFees0);
        if (actualFees1 != 0) token1.transfer(msg.sender, actualFees1);
    }

    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _shares[poolId][beneficiary];
    }

    function getCumulatedFees0(bytes32 poolId) external view returns (uint256) {
        return reportedCumulatedFees0[poolId];
    }

    function getCumulatedFees1(bytes32 poolId) external view returns (uint256) {
        return reportedCumulatedFees1[poolId];
    }

    function getLastCumulatedFees0(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _lastReportedFees0[poolId][beneficiary];
    }

    function getLastCumulatedFees1(bytes32 poolId, address beneficiary) external view returns (uint256) {
        return _lastReportedFees1[poolId][beneficiary];
    }
}

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
