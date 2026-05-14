# DM / chat — structured intents (Bankr agent)

Ask the user for **facts in one message** so you never guess chain, addresses, or order.

## Sell fee rights (two product paths)

**Path A — Receipt only (no marketplace listing):** escrow → beneficiary → finalize → user holds BFRR; **no** `FeeRightsFixedSale.list`.

**Path B — List for sale:** after BFRR exists in seller wallet, **`approve(marketplace, tokenId)`** then **`list`** with **`priceWei > 0`**. On-chain: **listed** (marketplace holds NFT) until **buy** or **cancel** returns it. **Not** “optional list” inside the same mental model as Path A — use a **separate** CTA in the app.

User should send something like:

```text
Chain: Base
Launched token: 0x...        # ERC20 the pool is for (e.g. t4)
My wallet (seller): 0x...
Escrow (BankrEscrowV3): 0x...   # canonical deploy
BFRR collection: 0x...
Marketplace (FeeRightsFixedSale): 0x...
Path: receipt_only | list_for_sale
If list_for_sale: list price ETH: <number>   # must be > 0
```

**You (agent) must then:**

1. Resolve **`feeManager`** (initializer) with the **same resolver** the product uses for **`build-transfer-beneficiary`** — **not** a hardcoded address unless verified.  
2. Resolve **`poolId`**, **`token0`**, **`token1`** (sorted per pool; WETH on Base is `0x4200000000000000000000000000000000000006` when applicable).  
3. Confirm **`allowedFeeManager(feeManager)`** on escrow is **true** (else owner calls `setFeeManagerAllowed` once per manager).  
4. **`eth_call`** `getShares(poolId, seller)` on **that** `feeManager` — must **return a uint** (not revert). **`Revert ≠ “no shares”`** (wrong contract). **`0`** ⇒ `CallerDoesNotOwnRights` if they `prepare` anyway.  
5. Guide **`prepareDeposit` → beneficiary to escrow → finalize`** in that order (see main `SKILL.md`).  
6. If listing: **`approve(marketplace, tokenId)`** (preferred) or **`setApprovalForAll(marketplace, true)`**, then **`list`** with **`priceWei > 0`**.

## Quick list only (BFRR already in wallet — ask Bankr product)

Paste to Bankr / marketplace team:

```text
When the seller already holds BFRR (finalize done), add a "List only" path on SELL:
- Collect list price in ETH (> 0).
- Call approve(FeeRightsFixedSale, tokenId) then list(...) — skip prepareDeposit, beneficiary, and mint in the wizard.
- Keep the full orchestration for users who have not finalized yet.
```

## Bankr UI — listing is binary (paste to product)

```text
FeeRightsFixedSale has no "optional listing" state: either the BFRR is listed (held by marketplace until buy/cancel) or it is not (seller holds it).

Please remove "Optional" from the List step in Sell orchestration. Use two explicit flows:
- "Receipt only" = mint BFRR, no list.
- "List for sale" = require price > 0 and run approve + list; cancel listing returns BFRR to seller.

Do not use "0 ETH to skip listing" in the same flow as selling — that contradicts on-chain ZeroPrice.
```

## Bankr worker — `poolId` length (viem bytes31 / bytes33)

```text
Job fails: viem "bytes33" (or bytes31) vs expected bytes32 — the poolId string must be exactly 0x + 64 hex characters (32 bytes). If the error shows 66 hex chars after 0x, something is still appending extra nibbles (e.g. "0000") or concatenating two values. Please log: (1) raw poolId from token-fees API, (2) string length after 0x, (3) value passed into encodeAbiParameters — all three must show 64. Remove any placeholder hex (e.g. abcdef...) in production jobs.

Workaround for users who already hold BFRR: MANAGE → list for sale (skips PREPARE).
```

## Buy a listed BFRR

```text
Chain: Base
listingId: <uint>
My wallet (buyer): 0x...
Marketplace: 0x...
```

Read **`getListing(listingId)`**, confirm **`active`**, then **`buy`** with **`msg.value == priceWei`**.

## Stop / support

If the user is stuck, ask for **the latest tx hash** on BaseScan and whether they are **escrow owner** vs **seller** — many issues are **wrong role** or **wrong step order**.
