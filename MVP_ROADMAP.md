# MVP roadmap — Bankr fee-rights (Option B)

This file is the **scope-control and direction** document: what we ship as primitives first, what we defer, and how pieces compose.

## Option B: permissive ERC721 (chosen)

The receipt is a **normal transferable ERC721** (not a soulbound voucher).

That implies:

- **Composable** — any ERC721-aware tool can move the asset.
- **OpenSea-compatible later** — standard metadata and transfers; polish can follow.
- **OTC possible** — wallet-to-wallet sales without our UI.
- **Bankr mini app** — the “official” marketplace UX on top of the same NFTs.
- **Redemption stays in escrow** — Bankr fee rights change hands only through `BankrEscrowV3` flows (`redeemRights`, etc.), not through the sale contract.

We are building **primitives**, not a full exchange.

## Architecture (three layers)

1. **Escrow** — `BankrEscrowV3`: custody of Bankr-facing rights, claims, finalize, redeem, cancel while holding receipt, etc.
2. **Receipt NFT** — `BankrFeeRightsReceipt`: mint/burn only by escrow; encodes position metadata.
3. **Sale primitive** — `FeeRightsFixedSale`: (a) fixed-price `list` / `buy` / `cancel` with NFT in escrow while listed; (b) unsolicited ETH offers on any `(collection, tokenId)` via `placeOffer` / `withdrawOffer` / `acceptOffer` when there is no active fixed listing for that asset. Visibility: `totalOfferWei(collection, tokenId)`, `offerWei(collection, tokenId, bidder)`, and indexed `OfferPlaced` events.

End-to-end MVP path:

```text
Escrow V3 → receipt minted to seller → optional listing and/or standing offers → buyer `buy` or seller `acceptOffer` → holder redeems via escrow → receipt burns
```

## Design rule (non-negotiable)

**`FeeRightsFixedSale` must never call Bankr fee managers, pool logic, or escrow internals.** It only interacts with the **ERC721 interface** (`transferFrom` / `safeTransferFrom`) on whatever collection address is passed. In production that collection is the receipt contract; the contract stays ignorant of “fee rights” as a domain concept.

## What `FeeRightsFixedSale` does

**Listings:** custody the NFT while listed; `buy` pays exact ETH and transfers the NFT; `cancel` returns the NFT.

**Offers:** bidders lock ETH without the owner listing; current owner (or ERC721-approved operator) calls `acceptOffer` to take the bid (this contract must be approved to move the NFT, same as `list`). New `placeOffer` reverts while that asset has an active fixed listing; existing bidders can still `withdrawOffer`.

## Explicit non-goals (still out of scope)

No auctions, royalties, protocol token, buybacks, or Bankr-specific hooks inside this contract. No upgradeability in this slice. Offers are simple on-chain ETH locks, not an off-chain order book.

## In repo today

| Piece | Role |
| --- | --- |
| `BankrEscrowV3` + `BankrFeeRightsReceipt` | Escrow + receipt (see `README.md`, `NFT_RECEIPT_DESIGN.md`) |
| `FeeRightsFixedSale` | Fixed-price listings + ETH offer book (generic `IERC721`) |
| `script/DeployBankrEscrowV3.s.sol` | Escrow V3 + receipt (one broadcast; log both addresses) |
| `script/DeployFeeRightsFixedSale.s.sol` | Deploy script (use Base mainnet RPC for production; Sepolia ok for lab) |
| `test/FeeRightsFixedSale.t.sol` | Listing / buy / cancel paths |
| `test/FeeRightsOffers.t.sol` | Offer / accept / withdraw paths |
| `VERIFICATION.md` | BaseScan verify commands (Sepolia history + **mainnet** templates) |
| `LAUNCH_CHECKLIST.md` | **Production go-live:** deploy → verify → Railway → E2E before public post |

## Next (not blocking the primitive)

- Bankr mini app polish (`bankr-app/` is wired for **Base mainnet**; extend UX / escrow links as needed).
- Receipt metadata polish for secondary venues.

## For contributors

- Keep the sale contract **small and generic**; extend at the app layer or with new contracts, not by entangling Bankr into `FeeRightsFixedSale`.
- Favor **additional scripts/tests** over growing the primitive until a clear v2 need exists.
