// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "openzeppelin-contracts/contracts/interfaces/draft-IERC6093.sol";
import {ClankerEscrowV4} from "../src/ClankerEscrowV4.sol";
import {BankrFeeRightsReceipt} from "../src/BankrFeeRightsReceipt.sol";
import {IClankerLockerV4} from "../src/interfaces/IClankerLockerV4.sol";

// ── Mock v4 locker ─────────────────────────────────────────────────────────────

contract MockClankerLockerV4 {
    struct State {
        address admin;
        address recipient;
    }

    mapping(address token => State[]) private _states;
    mapping(address token => IClankerLockerV4.PoolKey) private _poolKeys;

    function seed(address token, address currency0, address currency1, address admin, address recipient) external {
        _poolKeys[token] = IClankerLockerV4.PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        _states[token].push(State({admin: admin, recipient: recipient}));
    }

    function tokenRewards(address token) external view returns (IClankerLockerV4.TokenRewardInfo memory info) {
        State[] storage s = _states[token];
        address[] memory admins = new address[](s.length);
        address[] memory recipients = new address[](s.length);
        uint16[] memory bps = new uint16[](s.length);
        for (uint256 i = 0; i < s.length; i++) {
            admins[i] = s[i].admin;
            recipients[i] = s[i].recipient;
            bps[i] = 10000;
        }
        info = IClankerLockerV4.TokenRewardInfo({
            token: token,
            poolKey: _poolKeys[token],
            positionId: 1,
            numPositions: 1,
            rewardBps: bps,
            rewardAdmins: admins,
            rewardRecipients: recipients
        });
    }

    function updateRewardAdmin(address token, uint256 rewardIndex, address newAdmin) external {
        require(rewardIndex < _states[token].length, "oob");
        require(_states[token][rewardIndex].admin == msg.sender, "not admin");
        _states[token][rewardIndex].admin = newAdmin;
    }

    function updateRewardRecipient(address token, uint256 rewardIndex, address newRecipient) external {
        require(rewardIndex < _states[token].length, "oob");
        require(_states[token][rewardIndex].admin == msg.sender, "not admin");
        _states[token][rewardIndex].recipient = newRecipient;
    }
}

// ── Test ───────────────────────────────────────────────────────────────────────

contract ClankerEscrowV4Test is Test {
    address private constant ADMIN = address(0xA11CE);
    address private constant SELLER = address(0x5E11E2);
    address private constant BUYER = address(0xB0B);
    address private constant ATTACKER = address(0xBAD);

    address private constant TOKEN0 = address(0xC0);
    address private constant TOKEN1 = address(0xC1);
    address private constant CLANKER_TOKEN = address(0xC2);
    uint256 private constant REWARD_INDEX = 0;

    BankrFeeRightsReceipt private tmpr;
    ClankerEscrowV4 private escrow;
    MockClankerLockerV4 private locker;

    function setUp() public {
        tmpr = new BankrFeeRightsReceipt(ADMIN);
        escrow = new ClankerEscrowV4(ADMIN, tmpr);

        vm.prank(ADMIN);
        tmpr.setEscrowAuthorized(address(escrow), true);

        locker = new MockClankerLockerV4();
        locker.seed(CLANKER_TOKEN, TOKEN0, TOKEN1, SELLER, SELLER);

        vm.prank(ADMIN);
        escrow.setLockerAllowed(address(locker), true);
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    function _prepare() internal {
        vm.prank(SELLER);
        escrow.prepareDeposit(address(locker), CLANKER_TOKEN, REWARD_INDEX, TOKEN0, TOKEN1);
    }

    function _transferRecipient() internal {
        // Seller is still admin at this point.
        vm.prank(SELLER);
        locker.updateRewardRecipient(CLANKER_TOKEN, REWARD_INDEX, address(escrow));
    }

    function _transferAdmin() internal {
        // After updateRewardRecipient, admin is still seller.
        vm.prank(SELLER);
        locker.updateRewardAdmin(CLANKER_TOKEN, REWARD_INDEX, address(escrow));
    }

    function _fullDeposit() internal returns (uint256 tokenId) {
        _prepare();
        _transferRecipient();
        _transferAdmin();
        vm.prank(SELLER);
        tokenId = escrow.finalizeDeposit(address(locker), CLANKER_TOKEN, REWARD_INDEX);
    }

    // ── tests ──────────────────────────────────────────────────────────────────

    function testPrepareDepositStoresFields() public {
        _prepare();
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        assertEq(escrow.pendingSeller(key), SELLER);
    }

    function testPrepareRevertsIfNotAdmin() public {
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(ClankerEscrowV4.CallerIsNotRewardAdmin.selector, key, ATTACKER)
        );
        escrow.prepareDeposit(address(locker), CLANKER_TOKEN, REWARD_INDEX, TOKEN0, TOKEN1);
    }

    function testPrepareRevertsLockerNotAllowed() public {
        address badLocker = address(0xDEAD);
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(ClankerEscrowV4.LockerNotAllowed.selector, badLocker));
        escrow.prepareDeposit(badLocker, CLANKER_TOKEN, REWARD_INDEX, TOKEN0, TOKEN1);
    }

    function testFinalizeMintsReceipt() public {
        uint256 tokenId = _fullDeposit();
        assertEq(tmpr.ownerOf(tokenId), SELLER);

        BankrFeeRightsReceipt.Position memory p = tmpr.positionOf(tokenId);
        assertEq(p.feeManager, address(locker));
        assertEq(p.token0, TOKEN0);
        assertEq(p.token1, TOKEN1);
        assertEq(p.seller, SELLER);
    }

    function testFinalizeRevertsIfNotAdminAndRecipient() public {
        _prepare();
        // Only transfer recipient — skip admin transfer.
        _transferRecipient();
        // Escrow is recipient but NOT admin yet (seller is still admin).
        // Wait, in our mock, updateRewardRecipient requires caller to be admin.
        // So after _transferRecipient, admin is still SELLER.
        // Now let's transfer admin to escrow ONLY without recipient — reset first.
        // To test this separately: reset the state by using a fresh locker position.
        // Instead just test finalize fails if neither has been transferred.
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        // At this point recipient = escrow, admin = SELLER.
        // Finalize should revert because admin != escrow.
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(ClankerEscrowV4.EscrowNotAdminAndRecipient.selector, key));
        escrow.finalizeDeposit(address(locker), CLANKER_TOKEN, REWARD_INDEX);
    }

    function testIsEscrowedAfterFinalize() public {
        _fullDeposit();
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        assertTrue(escrow.isEscrowed(key));
    }

    function testRedeemRightsBurnsReceiptAndTransfersRoles() public {
        uint256 tokenId = _fullDeposit();

        // Transfer NFT to buyer.
        vm.prank(SELLER);
        tmpr.transferFrom(SELLER, BUYER, tokenId);
        assertEq(tmpr.ownerOf(tokenId), BUYER);

        vm.prank(BUYER);
        escrow.redeemRights(tokenId);

        // Receipt should be burned.
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        tmpr.ownerOf(tokenId);

        // Buyer should now be admin and recipient.
        IClankerLockerV4.TokenRewardInfo memory info = locker.tokenRewards(CLANKER_TOKEN);
        assertEq(info.rewardAdmins[REWARD_INDEX], BUYER);
        assertEq(info.rewardRecipients[REWARD_INDEX], BUYER);

        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        assertFalse(escrow.isEscrowed(key));
        assertEq(escrow.feeRecipientForKey(key), BUYER);
    }

    function testCancelPendingDepositBySellerSucceeds() public {
        _prepare();
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);

        vm.prank(SELLER);
        escrow.cancelPendingDeposit(address(locker), CLANKER_TOKEN, REWARD_INDEX);

        assertEq(escrow.pendingSeller(key), address(0));
    }

    function testCancelRightsReturnsRolesToSeller() public {
        uint256 tokenId = _fullDeposit();
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);

        vm.prank(SELLER);
        escrow.cancelRights(address(locker), CLANKER_TOKEN, REWARD_INDEX);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        tmpr.ownerOf(tokenId);

        IClankerLockerV4.TokenRewardInfo memory info = locker.tokenRewards(CLANKER_TOKEN);
        assertEq(info.rewardAdmins[REWARD_INDEX], SELLER);
        assertEq(info.rewardRecipients[REWARD_INDEX], SELLER);
        assertFalse(escrow.isEscrowed(key));
    }

    function testCancelRightsByAdminSucceeds() public {
        uint256 tokenId = _fullDeposit();

        vm.prank(ADMIN);
        escrow.cancelRights(address(locker), CLANKER_TOKEN, REWARD_INDEX);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId));
        tmpr.ownerOf(tokenId);
    }

    function testSellerCannotCancelAfterNftTransfer() public {
        _fullDeposit();
        uint256 tokenId = escrow.tokenIdFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);

        vm.prank(SELLER);
        tmpr.transferFrom(SELLER, BUYER, tokenId);

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(ClankerEscrowV4.SellerCannotCancelAfterNftTransfer.selector, key)
        );
        escrow.cancelRights(address(locker), CLANKER_TOKEN, REWARD_INDEX);
    }

    function testReleaseRightsByOwner() public {
        _fullDeposit();

        vm.prank(ADMIN);
        escrow.releaseRights(address(locker), CLANKER_TOKEN, REWARD_INDEX, BUYER);

        IClankerLockerV4.TokenRewardInfo memory info = locker.tokenRewards(CLANKER_TOKEN);
        assertEq(info.rewardAdmins[REWARD_INDEX], BUYER);
        assertEq(info.rewardRecipients[REWARD_INDEX], BUYER);
    }

    function testDoublePrepareReverts() public {
        _prepare();
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(ClankerEscrowV4.DepositAlreadyPending.selector, key));
        escrow.prepareDeposit(address(locker), CLANKER_TOKEN, REWARD_INDEX, TOKEN0, TOKEN1);
    }

    function testDoubleEscrowReverts() public {
        _fullDeposit();
        // New locker position reset so admin is SELLER again.
        locker.seed(CLANKER_TOKEN, TOKEN0, TOKEN1, SELLER, SELLER);
        // Still isEscrowed for this key.
        bytes32 key = escrow.keyFor(address(locker), CLANKER_TOKEN, REWARD_INDEX);
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(ClankerEscrowV4.RightsAlreadyEscrowed.selector, key));
        escrow.prepareDeposit(address(locker), CLANKER_TOKEN, REWARD_INDEX, TOKEN0, TOKEN1);
    }
}
