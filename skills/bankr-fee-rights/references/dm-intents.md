# DM / chat — structured intents (Bankr agent)

Ask the user for **facts in one message** so you never guess chain, addresses, or order.

## Sell fee rights (full path → BFRR, optional list)

User should send something like:

```text
Chain: Base
Launched token: 0x...        # ERC20 the pool is for (e.g. t4)
My wallet (seller): 0x...
Escrow (BankrEscrowV3): 0x...   # canonical deploy
BFRR collection: 0x...
Marketplace (FeeRightsFixedSale): 0x...
List after mint: yes | no
If yes, list price ETH: <number>   # must be > 0 if listing
```

**You (agent) must then:**

1. Resolve **`feeManager`** (initializer) with the **same resolver** the product uses for **`build-transfer-beneficiary`** — **not** a hardcoded address unless verified.  
2. Resolve **`poolId`**, **`token0`**, **`token1`** (sorted per pool; WETH on Base is `0x4200000000000000000000000000000000000006` when applicable).  
3. Confirm **`allowedFeeManager(feeManager)`** on escrow is **true** (else owner calls `setFeeManagerAllowed` once per manager).  
4. **`eth_call`** `getShares(poolId, seller)` on **that** `feeManager` — must **return a uint** (not revert). **`Revert ≠ “no shares”`** (wrong contract). **`0`** ⇒ `CallerDoesNotOwnRights` if they `prepare` anyway.  
5. Guide **`prepareDeposit` → beneficiary to escrow → finalize`** in that order (see main `SKILL.md`).  
6. If listing: **`setApprovalForAll`** then **`list`** with **`priceWei > 0`**.

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
