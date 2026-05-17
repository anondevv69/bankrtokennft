// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import {GroupBuyEscrow, SplitV2Params, IPushSplitFactory} from "../src/GroupBuyEscrow.sol";
import {BankrEscrowV3} from "../src/BankrEscrowV3.sol";
import {BankrFeeRightsReceipt} from "../src/BankrFeeRightsReceipt.sol";
import {MockERC20, MockBankrFeesManagerV2} from "./MockBankrFeesV2.sol";

// ── Mock 0xSplits PushSplitFactory ────────────────────────────────────────────

/// @dev Deploys a real contract per split so ownerOf / code-size checks pass.
contract MockPushSplitFactory {
    address public lastSplit;
    address public lastOwner;

    address[] private _lastRecipients;
    uint256[] private _lastAllocations;
    uint256 public lastTotalAllocation;
    uint16 public lastDistributionIncentive;

    function createSplit(SplitV2Params calldata params, address owner, address /*creator*/ )
        external
        returns (address split)
    {
        MockSplitWallet wallet = new MockSplitWallet();
        split = address(wallet);
        lastSplit = split;
        lastOwner = owner;

        delete _lastRecipients;
        delete _lastAllocations;
        for (uint256 i = 0; i < params.recipients.length; i++) {
            _lastRecipients.push(params.recipients[i]);
            _lastAllocations.push(params.allocations[i]);
        }
        lastTotalAllocation = params.totalAllocation;
        lastDistributionIncentive = params.distributionIncentive;
    }

    function getLastParams() external view returns (SplitV2Params memory) {
        return SplitV2Params({
            recipients: _lastRecipients,
            allocations: _lastAllocations,
            totalAllocation: lastTotalAllocation,
            distributionIncentive: lastDistributionIncentive
        });
    }
}

contract MockSplitWallet is IERC721Receiver {
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

// ── Test ─────────────────────────────────────────────────────────────────────

contract GroupBuyEscrowTest is Test {
    uint256 private constant FULL_SHARE = 1e18;
    bytes32 private constant POOL_ID = keccak256("GROUP_BUY_POOL");

    address private constant ADMIN = address(0xA11CE);
    address private constant SELLER = address(0x5E11);
    address private constant BUYER_A = address(0xA1);
    address private constant BUYER_B = address(0xB2);
    address private constant BUYER_C = address(0xC3);
    address private constant FEE_VAULT = address(0xFEE5);

    GroupBuyEscrow private gbe;
    MockPushSplitFactory private factory;
    BankrEscrowV3 private bankrEscrow;
    BankrFeeRightsReceipt private tmpr;
    MockBankrFeesManagerV2 private feesManager;
    MockERC20 private token0;
    MockERC20 private token1;

    uint256 private tmprTokenId;

    function setUp() public {
        token0 = new MockERC20("Wrapped Ether", "WETH");
        token1 = new MockERC20("Bankr Token", "BNKR");
        feesManager = new MockBankrFeesManagerV2(token0, token1);

        tmpr = new BankrFeeRightsReceipt(ADMIN, ADMIN);
        bankrEscrow = new BankrEscrowV3(ADMIN, tmpr);

        vm.prank(ADMIN);
        tmpr.setEscrowAuthorized(address(bankrEscrow), true);
        vm.prank(ADMIN);
        bankrEscrow.setFeeManagerAllowed(address(feesManager), true);

        factory = new MockPushSplitFactory();
        gbe = new GroupBuyEscrow(FEE_VAULT, address(factory));

        // Mint a TMPR NFT to SELLER by escrowing via BankrEscrowV3
        feesManager.seedBeneficiary(POOL_ID, SELLER, FULL_SHARE);
        vm.prank(SELLER);
        bankrEscrow.prepareDeposit(address(feesManager), POOL_ID, address(token0), address(token1));
        feesManager.seedBeneficiary(POOL_ID, address(bankrEscrow), FULL_SHARE);
        feesManager.seedBeneficiary(POOL_ID, SELLER, 0);
        vm.prank(SELLER);
        tmprTokenId = bankrEscrow.finalizeDeposit(POOL_ID);

        // Fund test accounts
        vm.deal(BUYER_A, 10 ether);
        vm.deal(BUYER_B, 10 ether);
        vm.deal(BUYER_C, 10 ether);
        vm.deal(SELLER, 1 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createListing
    // ─────────────────────────────────────────────────────────────────────────

    function testCreateListingTransfersNftAndStores() public {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        uint256 id = gbe.createListing(IERC721(address(tmpr)), tmprTokenId, 1 ether, 1 hours, 0, address(bankrEscrow));

        assertEq(id, 1);
        assertEq(tmpr.ownerOf(tmprTokenId), address(gbe));

        GroupBuyEscrow.Listing memory li = gbe.getListing(id);
        assertEq(li.seller, SELLER);
        assertEq(li.priceWei, 1 ether);
        assertEq(li.sellerKeepsBps, 0);
        assertTrue(li.active);
        assertFalse(li.finalized);
    }

    function testCreateListingRevertsOnZeroPrice() public {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        vm.expectRevert(GroupBuyEscrow.ZeroPrice.selector);
        gbe.createListing(IERC721(address(tmpr)), tmprTokenId, 0, 1 hours, 0, address(bankrEscrow));
    }

    function testCreateListingRevertsOnShortDuration() public {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        vm.expectRevert(GroupBuyEscrow.InvalidDuration.selector);
        gbe.createListing(IERC721(address(tmpr)), tmprTokenId, 1 ether, 4 minutes, 0, address(bankrEscrow));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // contribute
    // ─────────────────────────────────────────────────────────────────────────

    function testContributeAcceptsEthAndRecordsIt() public {
        uint256 listingId = _list(1 ether);

        vm.prank(BUYER_A);
        gbe.contribute{value: 0.4 ether}(listingId);

        assertEq(gbe.getContribution(listingId, BUYER_A), 0.4 ether);
        assertEq(gbe.getListing(listingId).totalRaised, 0.4 ether);
    }

    function testContributeRefundsExcess() public {
        uint256 listingId = _list(1 ether);
        uint256 balBefore = BUYER_A.balance;

        vm.prank(BUYER_A);
        gbe.contribute{value: 1.5 ether}(listingId); // 0.5 excess

        assertEq(gbe.getContribution(listingId, BUYER_A), 1 ether);
        assertEq(BUYER_A.balance, balBefore - 1 ether);
    }

    function testContributeAccumulatesFromSameContributor() public {
        uint256 listingId = _list(1 ether);

        vm.prank(BUYER_A);
        gbe.contribute{value: 0.3 ether}(listingId);
        vm.prank(BUYER_A);
        gbe.contribute{value: 0.2 ether}(listingId);

        assertEq(gbe.getContribution(listingId, BUYER_A), 0.5 ether);
        assertEq(gbe.getContributors(listingId).length, 1); // deduplicated
    }

    function testContributeRevertsAfterDeadline() public {
        uint256 listingId = _list(1 ether);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(BUYER_A);
        vm.expectRevert(GroupBuyEscrow.ListingInactive.selector);
        gbe.contribute{value: 0.5 ether}(listingId);
    }

    function testContributeRevertsOnMinContribution() public {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        uint256 id = gbe.createListing(
            IERC721(address(tmpr)), tmprTokenId, 1 ether, 1 hours, 0.1 ether, address(bankrEscrow)
        );

        vm.prank(BUYER_A);
        vm.expectRevert(GroupBuyEscrow.ContributionTooSmall.selector);
        gbe.contribute{value: 0.05 ether}(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // finalize – group buy (TMPR path)
    // ─────────────────────────────────────────────────────────────────────────

    function testFinalizeGroupBuyCreatesSplitAndTransfersFeeRights() public {
        uint256 listingId = _list(1 ether);

        vm.prank(BUYER_A);
        gbe.contribute{value: 0.6 ether}(listingId);
        vm.prank(BUYER_B);
        gbe.contribute{value: 0.4 ether}(listingId);

        uint256 sellerBalBefore = SELLER.balance;
        uint256 vaultBalBefore = FEE_VAULT.balance;

        gbe.finalize(listingId);

        address split = factory.lastSplit();
        assertFalse(split == address(0));

        // Split params: A gets 60%, B gets 40% of totalAlloc.
        SplitV2Params memory params = factory.getLastParams();
        assertEq(params.recipients.length, 2);
        assertEq(params.totalAllocation, 1 ether);
        _assertRecipientAlloc(params, BUYER_A, 0.6 ether);
        _assertRecipientAlloc(params, BUYER_B, 0.4 ether);

        // Bankr fee rights: split is now the beneficiary on IBankrFees.
        assertEq(feesManager.getShares(POOL_ID, split), FULL_SHARE);
        assertEq(feesManager.getShares(POOL_ID, address(bankrEscrow)), 0);
        assertEq(feesManager.getShares(POOL_ID, address(gbe)), 0);

        // TMPR NFT burned.
        vm.expectRevert();
        tmpr.ownerOf(tmprTokenId);

        // Seller paid (1 ether - 2% fee = 0.98 ether).
        assertEq(SELLER.balance - sellerBalBefore, 0.98 ether);
        assertEq(FEE_VAULT.balance - vaultBalBefore, 0.02 ether);

        GroupBuyEscrow.Listing memory li = gbe.getListing(listingId);
        assertTrue(li.finalized);
        assertFalse(li.active);
        assertEq(li.splitAddress, split);
    }

    function testFinalizeRevertsIfNotFullyFunded() public {
        uint256 listingId = _list(1 ether);
        vm.prank(BUYER_A);
        gbe.contribute{value: 0.5 ether}(listingId);

        vm.expectRevert(GroupBuyEscrow.NotFullyFunded.selector);
        gbe.finalize(listingId);
    }

    function testFinalizeRevertsIfAlreadyFinalized() public {
        uint256 listingId = _listAndFill(1 ether);
        gbe.finalize(listingId);

        vm.expectRevert(GroupBuyEscrow.AlreadyFinalized.selector);
        gbe.finalize(listingId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // finalize – single buyer (edge case)
    // ─────────────────────────────────────────────────────────────────────────

    function testFinalizeSingleBuyerGetsSplit() public {
        uint256 listingId = _list(1 ether);
        vm.prank(BUYER_A);
        gbe.contribute{value: 1 ether}(listingId);

        gbe.finalize(listingId);

        SplitV2Params memory params = factory.getLastParams();
        assertEq(params.recipients.length, 1);
        assertEq(params.recipients[0], BUYER_A);
        assertEq(params.allocations[0], 1 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // finalize – generic ERC-721 path (no bankrEscrow)
    // ─────────────────────────────────────────────────────────────────────────

    function testFinalizeGenericErc721TransfersNftToSplit() public {
        // Use the TMPR as a generic NFT (no bankrEscrow → just transfer)
        // Re-mint a fresh token so we have one not in the escrow.
        address newRecipient = address(0x999);
        // We'll deploy a fresh receipt and mint to SELLER directly for test isolation.
        BankrFeeRightsReceipt freshReceipt = new BankrFeeRightsReceipt(ADMIN, ADMIN);
        vm.prank(ADMIN);
        freshReceipt.setEscrowAuthorized(ADMIN, true);
        BankrFeeRightsReceipt.Position memory pos = BankrFeeRightsReceipt.Position({
            feeManager: address(feesManager),
            poolId: keccak256("OTHER_POOL"),
            token0: address(token0),
            token1: address(token1),
            seller: SELLER,
            factoryName: "Test"
        });
        uint256 freshId = 42;
        vm.prank(ADMIN);
        freshReceipt.mint(SELLER, freshId, pos);

        vm.prank(SELLER);
        freshReceipt.approve(address(gbe), freshId);
        vm.prank(SELLER);
        uint256 listingId = gbe.createListing(
            IERC721(address(freshReceipt)), freshId, 0.5 ether, 1 hours, 0, address(0)
        );

        vm.prank(BUYER_A);
        gbe.contribute{value: 0.5 ether}(listingId);

        gbe.finalize(listingId);

        address split = factory.lastSplit();
        assertEq(freshReceipt.ownerOf(freshId), split);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createPartialListing / partial sale
    // ─────────────────────────────────────────────────────────────────────────

    function testPartialSaleSellerKeepsShareInSplit() public {
        // Seller keeps 80%, contributor buys 20% for 0.02 ETH.
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        uint256 listingId = gbe.createPartialListing(
            IERC721(address(tmpr)), tmprTokenId, 0.02 ether, 1 hours, 0, 8000, address(bankrEscrow)
        );

        vm.prank(BUYER_A);
        gbe.contribute{value: 0.02 ether}(listingId);

        uint256 sellerBalBefore = SELLER.balance;
        gbe.finalize(listingId);

        SplitV2Params memory params = factory.getLastParams();

        // totalAlloc = BPS_DENOM * totalRaised = 10000 * 0.02 ether = 200 ether (in wei × BPS space)
        // Seller alloc = 8000 * 0.02 ether = 160 ether
        // BuyerA alloc = 0.02 ether * 2000 = 40 ether
        assertEq(params.totalAllocation, 200 ether);
        _assertRecipientAlloc(params, SELLER, 160 ether);
        _assertRecipientAlloc(params, BUYER_A, 40 ether);

        // Fee rights now belong to the split on IBankrFees.
        address split = factory.lastSplit();
        assertEq(feesManager.getShares(POOL_ID, split), FULL_SHARE);

        // Seller receives 0.02 ETH - 2% = 0.0196 ETH.
        assertApproxEqAbs(SELLER.balance - sellerBalBefore, 0.0196 ether, 1);
    }

    function testPartialSaleSellerCannotContribute() public {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        uint256 id = gbe.createPartialListing(
            IERC721(address(tmpr)), tmprTokenId, 0.1 ether, 1 hours, 0, 5000, address(bankrEscrow)
        );

        vm.prank(SELLER);
        vm.expectRevert(GroupBuyEscrow.SellerCannotContributeInPartialMode.selector);
        gbe.contribute{value: 0.1 ether}(id);
    }

    function testCreatePartialListingRevertsOnZeroBps() public {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        vm.expectRevert(GroupBuyEscrow.InvalidSellerKeepsBps.selector);
        gbe.createPartialListing(
            IERC721(address(tmpr)), tmprTokenId, 0.1 ether, 1 hours, 0, 0, address(bankrEscrow)
        );
    }

    function testCreatePartialListingRevertsOnFullBps() public {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        vm.expectRevert(GroupBuyEscrow.InvalidSellerKeepsBps.selector);
        gbe.createPartialListing(
            IERC721(address(tmpr)), tmprTokenId, 0.1 ether, 1 hours, 0, 10000, address(bankrEscrow)
        );
    }

    function testPartialSaleThreeBuyers() public {
        // Seller keeps 50%, 3 buyers split 50% proportionally.
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        uint256 id = gbe.createPartialListing(
            IERC721(address(tmpr)), tmprTokenId, 0.1 ether, 1 hours, 0, 5000, address(bankrEscrow)
        );

        vm.prank(BUYER_A);
        gbe.contribute{value: 0.05 ether}(id);
        vm.prank(BUYER_B);
        gbe.contribute{value: 0.03 ether}(id);
        vm.prank(BUYER_C);
        gbe.contribute{value: 0.02 ether}(id);

        gbe.finalize(id);

        SplitV2Params memory params = factory.getLastParams();
        assertEq(params.recipients.length, 4); // seller + 3 buyers

        // totalAlloc = 10000 * 0.1 ether = 1000 ether
        // Seller (50%): 5000 * 0.1 ether = 500 ether
        // A: 0.05 ether * 5000 = 250 ether
        // B: 0.03 ether * 5000 = 150 ether
        // C: 0.02 ether * 5000 = 100 ether
        assertEq(params.totalAllocation, 1000 ether);
        _assertRecipientAlloc(params, SELLER, 500 ether);
        _assertRecipientAlloc(params, BUYER_A, 250 ether);
        _assertRecipientAlloc(params, BUYER_B, 150 ether);
        _assertRecipientAlloc(params, BUYER_C, 100 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // refundAll + claimRefund
    // ─────────────────────────────────────────────────────────────────────────

    function testRefundAllReturnsFundsAfterDeadline() public {
        uint256 listingId = _list(1 ether);
        vm.prank(BUYER_A);
        gbe.contribute{value: 0.4 ether}(listingId);
        vm.prank(BUYER_B);
        gbe.contribute{value: 0.3 ether}(listingId);

        vm.warp(block.timestamp + 2 hours); // past deadline

        uint256 balA = BUYER_A.balance;
        uint256 balB = BUYER_B.balance;

        gbe.refundAll(listingId);

        assertEq(BUYER_A.balance, balA + 0.4 ether);
        assertEq(BUYER_B.balance, balB + 0.3 ether);
        assertEq(tmpr.ownerOf(tmprTokenId), SELLER); // NFT returned
        assertFalse(gbe.getListing(listingId).active);
    }

    function testRefundAllRevertsBeforeDeadline() public {
        uint256 listingId = _list(1 ether);
        vm.prank(BUYER_A);
        gbe.contribute{value: 0.5 ether}(listingId);

        vm.expectRevert(GroupBuyEscrow.DeadlineNotReached.selector);
        gbe.refundAll(listingId);
    }

    function testRefundAllRevertsIfFullyFunded() public {
        uint256 listingId = _listAndFill(1 ether);
        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert(GroupBuyEscrow.FullyFunded.selector);
        gbe.refundAll(listingId);
    }

    function testClaimRefundWorksAfterFailedPush() public {
        uint256 listingId = _list(1 ether);
        vm.prank(BUYER_A);
        gbe.contribute{value: 0.4 ether}(listingId);
        vm.prank(BUYER_B);
        gbe.contribute{value: 0.3 ether}(listingId);

        vm.warp(block.timestamp + 2 hours);
        gbe.refundAll(listingId);

        // Simulate claimRefund for residual (normally used when push failed; here it reverts with NothingToRefund)
        vm.prank(BUYER_A);
        vm.expectRevert(GroupBuyEscrow.NothingToRefund.selector);
        gbe.claimRefund(listingId);
    }

    function testClaimRefundRevertsOnFinalizedListing() public {
        uint256 listingId = _listAndFill(1 ether);
        gbe.finalize(listingId);

        vm.prank(BUYER_A);
        vm.expectRevert(GroupBuyEscrow.AlreadyFinalized.selector);
        gbe.claimRefund(listingId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // cancel
    // ─────────────────────────────────────────────────────────────────────────

    function testCancelWithNoContributionsReturnsNft() public {
        uint256 listingId = _list(1 ether);

        vm.prank(SELLER);
        gbe.cancel(listingId);

        assertEq(tmpr.ownerOf(tmprTokenId), SELLER);
        assertFalse(gbe.getListing(listingId).active);
    }

    function testCancelRevertsWithContributions() public {
        uint256 listingId = _list(1 ether);
        vm.prank(BUYER_A);
        gbe.contribute{value: 0.1 ether}(listingId);

        vm.prank(SELLER);
        vm.expectRevert(GroupBuyEscrow.HasContributions.selector);
        gbe.cancel(listingId);
    }

    function testCancelRevertsIfNotSeller() public {
        uint256 listingId = _list(1 ether);

        vm.prank(BUYER_A);
        vm.expectRevert(GroupBuyEscrow.NotSeller.selector);
        gbe.cancel(listingId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // platform fee
    // ─────────────────────────────────────────────────────────────────────────

    function testFeeIsExactlyTwoPercent() public {
        uint256 price = 1 ether;
        uint256 listingId = _listAndFill(price);

        uint256 vaultBefore = FEE_VAULT.balance;
        uint256 sellerBefore = SELLER.balance;

        gbe.finalize(listingId);

        assertEq(FEE_VAULT.balance - vaultBefore, price * 200 / 10_000);
        assertEq(SELLER.balance - sellerBefore, price * 9800 / 10_000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // fuzz: proportional allocations
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzzGroupBuyAllocationsProportional(uint96 a, uint96 b) public {
        vm.assume(a > 0 && b > 0);
        uint256 price = uint256(a) + uint256(b);
        vm.assume(price > 0 && price <= 20 ether);

        uint256 listingId = _list(price);

        vm.deal(BUYER_A, price);
        vm.deal(BUYER_B, price);

        vm.prank(BUYER_A);
        gbe.contribute{value: a}(listingId);
        vm.prank(BUYER_B);
        gbe.contribute{value: b}(listingId);

        gbe.finalize(listingId);

        SplitV2Params memory params = factory.getLastParams();
        assertEq(params.totalAllocation, price);
        _assertRecipientAlloc(params, BUYER_A, a);
        _assertRecipientAlloc(params, BUYER_B, b);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _list(uint256 price) internal returns (uint256 listingId) {
        vm.prank(SELLER);
        tmpr.approve(address(gbe), tmprTokenId);
        vm.prank(SELLER);
        listingId = gbe.createListing(
            IERC721(address(tmpr)), tmprTokenId, price, 1 hours, 0, address(bankrEscrow)
        );
    }

    function _listAndFill(uint256 price) internal returns (uint256 listingId) {
        listingId = _list(price);
        vm.deal(BUYER_A, price);
        vm.prank(BUYER_A);
        gbe.contribute{value: price}(listingId);
    }

    function _assertRecipientAlloc(SplitV2Params memory params, address recipient, uint256 expectedAlloc) internal {
        for (uint256 i = 0; i < params.recipients.length; i++) {
            if (params.recipients[i] == recipient) {
                assertEq(params.allocations[i], expectedAlloc,
                    string.concat("wrong alloc for recipient"));
                return;
            }
        }
        revert("recipient not found in split");
    }
}
