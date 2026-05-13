# NFT Receipt Layer Design

This document starts the next protocol phase after Escrow V2 accounting validation. It is intentionally a design checkpoint, not marketplace implementation.

## Goal

Represent escrowed Bankr fee rights with a temporary ERC721 receipt while keeping custody, fee accounting, and withdrawal rules deterministic.

The NFT receipt should prove:

```text
one escrowed fee-right position = one transferable receipt NFT
```

The NFT should not create new fee rights. It should only represent rights already held by the escrow contract.

## Non-Goals

- No marketplace order book.
- No sales settlement.
- No protocol token.
- No fee splitting beyond the already validated terminal-recipient rule.
- No support for unescrowed or partially verified fee rights.

## Current Invariants From Escrow V2

Escrow V2 has already validated these properties on Base Sepolia:

- `prepareDeposit` records seller, fee manager, pool ID, `token0`, and `token1`.
- `finalizeDeposit` only succeeds after escrow owns the Bankr fee-right shares.
- `claimFees` accounts by actual token balance deltas.
- If rights are canceled, the seller receives claimed fees.
- If rights are released, the buyer/recipient receives claimed fees.
- `withdrawClaimedFees` clears internal accounting after transferring actual token balances.

The NFT layer must preserve these invariants.

## Proposed Receipt Model

Use an ERC721 receipt where each `tokenId` represents a single escrowed position.

Receipt metadata:

```solidity
struct Position {
    address feeManager;
    bytes32 poolId;
    address token0;
    address token1;
    address seller;
    bool active;
}
```

Recommended `tokenId`:

```text
uint256 tokenId = uint256(keccak256(abi.encode(feeManager, poolId)))
```

This avoids collisions if two fee managers ever use the same `poolId`.

## Lifecycle

```text
seller prepares deposit
→ seller transfers fee rights to escrow
→ seller finalizes deposit
→ receipt NFT mints to seller
→ receipt can transfer between wallets
→ current receipt owner can redeem/release rights
→ escrow releases Bankr rights to receipt owner
→ receipt burns
→ claimed fees become withdrawable by terminal recipient
```

## Authorization Rules

The receipt owner should control the escrowed rights.

Recommended rules:

- Only the original seller can cancel before a sale-style release, if no marketplace lock exists.
- The current NFT owner can redeem/release rights to themselves.
- The current NFT owner can claim fees while escrow owns the rights.
- Claimed fees follow Escrow V2 terminal-recipient rules:
  - canceled position -> seller receives fees,
  - released/redeemed position -> NFT owner receives fees.

The owner/admin should not be the normal release authority once the receipt layer exists. Admin powers should be limited to testnet emergency operations or removed before production.

## Contract Shape

Conservative next implementation:

```text
BankrFeeRightsReceipt (ERC721)
    owns receipt state
    mints only when escrow custody is finalized
    burns when rights are released/canceled

BankrEscrowV3
    inherits/ports Escrow V2 accounting
    integrates receipt mint/burn authorization
    keeps token-delta fee accounting unchanged
```

Prefer a V3 contract rather than mutating deployed V2. V2 remains the validated accounting primitive.

## Key Functions

Candidate external functions:

```solidity
prepareDeposit(address feeManager, bytes32 poolId, address token0, address token1)
finalizeDeposit(bytes32 poolId) returns (uint256 tokenId)
claimFees(uint256 tokenId)
cancelRights(uint256 tokenId)
redeemRights(uint256 tokenId)
withdrawClaimedFees(uint256 tokenId)
```

Possible view helpers:

```solidity
positionForToken(uint256 tokenId)
tokenForPosition(address feeManager, bytes32 poolId)
claimableFees(uint256 tokenId)
escrowShare(uint256 tokenId)
```

## Open Design Questions

1. Should claiming fees be allowed by anyone, or only the NFT owner?
2. Should accrued fees transfer with the NFT before redemption, or should they remain owed to the holder at claim time?
3. Should the seller be able to cancel after transferring the NFT?
4. Should redemption transfer rights directly to the NFT owner or to an explicit recipient chosen by the NFT owner?
5. Should the receipt NFT be soulbound during the first test phase, then made transferable later?

Recommended answers for the first implementation:

- Only the NFT owner can trigger release/redeem.
- Anyone may call `claimFees` if fees are credited to the position, because the value cannot be stolen.
- Accrued fees should follow the NFT owner at redemption time for the initial receipt model.
- Seller cancellation should be blocked after the NFT leaves the seller wallet.
- Redemption should default to the NFT owner; explicit recipient can come later.

## First Implementation Milestone

Build the smallest receipt layer that proves:

```text
escrowed rights
→ receipt minted
→ receipt transfers
→ receipt owner redeems rights
→ claimed fees withdraw correctly
```

Tests required:

- receipt mints only after escrow custody is verified,
- one receipt per `(feeManager, poolId)`,
- receipt owner can redeem rights,
- non-owner cannot redeem rights,
- seller cannot cancel after transferring receipt,
- claimed fees follow the correct terminal recipient,
- receipt burns after release/cancel,
- Escrow V2 balance-delta accounting remains unchanged.

## Deployment Rule

Deploy this as a new contract version after local tests pass. Do not replace or reuse the existing V2 deployment for NFT experiments.
