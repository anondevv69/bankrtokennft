// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IBankrFees} from "./interfaces/IBankrFees.sol";

/// @title BankrEscrowTest
/// @notice Custody proof of concept for transferable Bankr fee rights.
/// @dev This contract intentionally does not mint NFTs, run a marketplace, or
/// settle purchases. It only proves that fee rights can be held by a contract,
/// claimed while escrowed, and transferred back out by the contract.
contract BankrEscrowTest is Ownable, ReentrancyGuard {
    /// @notice Original seller for each escrowed Bankr pool.
    mapping(bytes32 poolId => address seller) public originalOwner;

    /// @notice Bankr fee manager address for each escrowed Bankr pool.
    mapping(bytes32 poolId => address feeManager) public feeManagerForPool;

    /// @notice True when a pool's Bankr fee rights are registered in escrow.
    mapping(bytes32 poolId => bool escrowed) public isEscrowed;

    /// @notice Emitted after escrow custody is verified and recorded.
    event RightsDeposited(bytes32 indexed poolId, address indexed feeManager, address indexed originalOwner);

    /// @notice Emitted after escrow transfers fee rights to a recipient.
    event RightsReleased(bytes32 indexed poolId, address indexed feeManager, address indexed to);

    /// @notice Emitted after escrow returns fee rights to the original seller.
    event RightsCancelled(bytes32 indexed poolId, address indexed feeManager, address indexed originalOwner);

    /// @notice Emitted after escrow claims fees while it owns the rights.
    event FeesClaimed(bytes32 indexed poolId, address indexed feeManager, uint256 fees0, uint256 fees1);

    error ZeroAddress();
    error RightsAlreadyEscrowed(bytes32 poolId);
    error RightsNotEscrowed(bytes32 poolId);
    error EscrowDoesNotOwnRights(bytes32 poolId);
    error UnauthorizedCaller(address caller);

    /// @param initialOwner Admin address allowed to release rights in this proof of concept.
    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Records a Bankr fee-right position after the seller transfers it to this escrow.
    /// @dev The seller/current beneficiary must first call Bankr's
    /// `updateBeneficiary(poolId, address(this))` on `feeManager`. This function
    /// only verifies and records custody; it cannot pull rights from the seller.
    /// @param feeManager Bankr fee manager contract for the token pool.
    /// @param poolId Stable Bankr pool identifier for the fee-right position.
    /// @param originalOwner_ Seller that transferred the rights into escrow.
    function depositRights(address feeManager, bytes32 poolId, address originalOwner_) external nonReentrant {
        if (feeManager == address(0) || originalOwner_ == address(0)) revert ZeroAddress();
        if (isEscrowed[poolId]) revert RightsAlreadyEscrowed(poolId);
        if (msg.sender != originalOwner_) revert UnauthorizedCaller(msg.sender);

        uint256 escrowShare = IBankrFees(feeManager).getShares(poolId, address(this));
        if (escrowShare == 0) revert EscrowDoesNotOwnRights(poolId);

        originalOwner[poolId] = originalOwner_;
        feeManagerForPool[poolId] = feeManager;
        isEscrowed[poolId] = true;

        emit RightsDeposited(poolId, feeManager, originalOwner_);
    }

    /// @notice Releases escrowed Bankr fee rights to `to`.
    /// @dev Owner-only for this custody proof. Marketplace/NFT authorization is
    /// deliberately left out until custody is proven.
    /// @param poolId Bankr pool whose fee rights should be released.
    /// @param to Recipient that will become the Bankr beneficiary.
    function releaseRights(bytes32 poolId, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        address feeManager = _requireEscrowed(poolId);
        IBankrFees(feeManager).updateBeneficiary(poolId, to);
        _clearEscrow(poolId);

        emit RightsReleased(poolId, feeManager, to);
    }

    /// @notice Returns escrowed Bankr fee rights to the original seller.
    /// @dev Allows either the seller or contract owner to cancel during this PoC.
    /// @param poolId Bankr pool whose fee rights should be returned.
    function cancelRights(bytes32 poolId) external nonReentrant {
        address feeManager = _requireEscrowed(poolId);
        address seller = originalOwner[poolId];

        if (msg.sender != seller && msg.sender != owner()) revert UnauthorizedCaller(msg.sender);

        IBankrFees(feeManager).updateBeneficiary(poolId, seller);
        _clearEscrow(poolId);

        emit RightsCancelled(poolId, feeManager, seller);
    }

    /// @notice Claims currently available fees while this contract is the beneficiary.
    /// @param poolId Bankr pool whose fees should be claimed.
    /// @return fees0 Amount of token0 fees claimed.
    /// @return fees1 Amount of token1 fees claimed.
    function claimFees(bytes32 poolId) external nonReentrant returns (uint256 fees0, uint256 fees1) {
        address feeManager = _requireEscrowed(poolId);

        (fees0, fees1) = IBankrFees(feeManager).collectFees(poolId);

        emit FeesClaimed(poolId, feeManager, fees0, fees1);
    }

    /// @notice Returns this escrow's current Bankr share allocation for `poolId`.
    /// @param poolId Bankr pool to inspect.
    function getEscrowShare(bytes32 poolId) external view returns (uint256) {
        address feeManager = _requireEscrowed(poolId);
        return IBankrFees(feeManager).getShares(poolId, address(this));
    }

    /// @notice Returns claimable fees based on Bankr's cumulative fee accounting.
    /// @dev Bankr docs note full live claimable also includes uncollected pool
    /// fees surfaced by simulating `collectFees`; this view covers recorded
    /// cumulative accounting and is enough for the custody proof.
    /// @param poolId Bankr pool to inspect.
    /// @return fees0 Estimated claimable token0 fees for the escrow.
    /// @return fees1 Estimated claimable token1 fees for the escrow.
    function getClaimableFees(bytes32 poolId) external view returns (uint256 fees0, uint256 fees1) {
        address feeManager = _requireEscrowed(poolId);
        IBankrFees fees = IBankrFees(feeManager);

        uint256 shares = fees.getShares(poolId, address(this));
        fees0 =
            ((fees.getCumulatedFees0(poolId) - fees.getLastCumulatedFees0(poolId, address(this))) * shares) / 1e18;
        fees1 =
            ((fees.getCumulatedFees1(poolId) - fees.getLastCumulatedFees1(poolId, address(this))) * shares) / 1e18;
    }

    /// @dev Loads the fee manager for a registered escrow position.
    function _requireEscrowed(bytes32 poolId) internal view returns (address feeManager) {
        if (!isEscrowed[poolId]) revert RightsNotEscrowed(poolId);
        feeManager = feeManagerForPool[poolId];
    }

    /// @dev Clears local escrow state after Bankr accepts the beneficiary transfer.
    function _clearEscrow(bytes32 poolId) internal {
        delete originalOwner[poolId];
        delete feeManagerForPool[poolId];
        delete isEscrowed[poolId];
    }
}
