---
name: bankr-fee-rights
description: Bankr Fee Rights Receipts (BFRR) on Base — escrow prepare/finalize, fee beneficiary to escrow, list at a price in ETH (wei), buy active listings, cancel. Use when the user sells or buys fee rights, lists BFRR for X ETH, buys a listing, listingId, FeeRightsFixedSale, BankrEscrowV3, prepareDeposit, finalizeDeposit, or Doppler fee recipient.
tags: [bankr, base, bfrr, escrow, doppler, defi]
version: 2
metadata:
  clawdbot:
    emoji: "🧾"
    homepage: "https://github.com/anondevv69/bankrtokennft/tree/main/fee-rights-exchange/skills/bankr-fee-rights"
---

# Bankr Fee Rights (BFRR) — Base mainnet

Guidance for agents helping users with **Bankr fee rights** custody, **BFRR** receipts, and **FeeRightsFixedSale** listings on **Base (chain id 8453)**.

**Primary UX:** the **Bankr Marketplace mini-app** should orchestrate txs (queued steps + receipts + one summary confirm). This skill supports **chat**, **support**, and **manual** Bankr wallet prompts — **do not** treat pasted raw JSON as the only execution path; prefer **structured** “send transaction … calling …” instructions (see [QR Coin skill pattern](https://github.com/BankrBot/skills/blob/main/qrcoin/SKILL.md)).

For repo contracts, ABIs, and launch QA: **`LAUNCH_CHECKLIST.md`**, **`BANKR_APP.md`**, **`README.md`** in [fee-rights-exchange](https://github.com/anondevv69/bankrtokennft).

---

## Canonical deployments (verify before mainnet advice)

These are **example production addresses** from this project’s Base deploy; **always confirm** on BaseScan / repo if user reports a mismatch.

| Role | Address |
|------|---------|
| **BankrEscrowV3** | `0xFb28D9C636514f8a9D129873750F9b886707d95F` |
| **BankrFeeRightsReceipt (BFRR)** | `0xB9E56dA4B83e77657296D7dE694754bd8b7d00db` |
| **FeeRightsFixedSale** (marketplace) | `0xA8163A62030a74F946eC73422EE692efE68AFE0B` |

Other addresses (**fee manager**, **poolId**, **token0/token1**) are **per launch** — resolve from your app’s metadata, Doppler/Bankr public APIs, or on-chain reads. Wrong `poolId` / token order ⇒ `prepareDeposit` reverts or wrong pool.

---

## On-chain flow (order matters)

1. **`prepareDeposit(feeManager, poolId, token0, token1)`** on **Escrow** — records **pending** seller = `msg.sender`. Caller must have **`getShares(poolId, msg.sender) > 0`** on the fee manager (holds rights *before* beneficiary moves to escrow).
2. **Fee beneficiary → escrow** — so shares move to escrow. Prefer Bankr **`execute-transfer-beneficiary`** / **`build-transfer-beneficiary`** ([Transferring fees](https://docs.bankr.bot/token-launching/transferring-fees)); Doppler/Clanker UI as fallback.
3. **`finalizeDeposit(poolId)`** on **Escrow** — seller only; escrow must hold shares; mints **BFRR**.
4. **List / buy** — **`FeeRightsFixedSale`**: approve marketplace for BFRR, then **`list(collection, tokenId, priceWei)`**; buyers use **`buy(listingId)`** with exact `msg.value`.

Never tell the user **“success”** until the matching tx **mined** and reads match (e.g. `pendingSeller`, shares on escrow).

---

## `prepareDeposit` encoding (critical)

- **Function:** `prepareDeposit(address feeManager, bytes32 poolId, address token0, address token1)`
- **Selector:** `0x6ac71ccc` (**four** arguments only — not a five-argument overload.)
- **Chain:** Base mainnet (`8453`).

### Example (t4-style pool — illustrative)

Fee manager `0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12`, poolId `0xc4db87d196ba3cdc05950eeec2d35de8cf76fb81cde996a5613682e99808cc8f`, token0 WETH `0x4200000000000000000000000000000000000006`, token1 `0xfc8ff3050def72b18083b119ce0cecab86b43ba3`.

Structured prompt for Bankr (adjust addresses after resolution):

```text
Send transaction to 0xFb28D9C636514f8a9D129873750F9b886707d95F on Base calling
prepareDeposit(
  0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12,
  0xc4db87d196ba3cdc05950eeec2d35de8cf76fb81cde996a5613682e99808cc8f,
  0x4200000000000000000000000000000000000006,
  0xfc8ff3050def72b18083b119ce0cecab86b43ba3
)
```

---

## Other selectors (reference)

| Function | Selector |
|----------|----------|
| `finalizeDeposit(bytes32)` | `0x3585ca61` |
| `list(address,uint256,uint256)` | `0xdda342bb` |
| `buy(uint256)` | `0xd96a094a` |

---

## Common `prepareDeposit` reverts (Escrow V3)

| Situation | Likely revert | What to check |
|-----------|---------------|----------------|
| Fee manager not allowlisted | `FeeManagerNotAllowed` | `allowedFeeManager(feeManager)` on escrow |
| Caller has no shares for pool | `CallerDoesNotOwnRights` | `getShares(poolId, user)` on fee manager; **signing wallet** must match rights holder |
| Pool already escrowed | `RightsAlreadyEscrowed` | Do not prepare again for same pool |
| Pending prepare exists | `DepositAlreadyPending` | Same pool; finish or cancel per product flow |
| `token0 == token1` or zero addr | `DuplicateTokenAddress` / `ZeroAddress` | Token pair |
| Stale fee dust on pool | `UnwithdrawnFees` | Accounting on that pool |

---

## Beneficiary transfer (prefer API over chat JSON)

- Bankr wallet: `POST /user/doppler/execute-transfer-beneficiary` (see [Transferring fees](https://docs.bankr.bot/token-launching/transferring-fees)).
- External wallet: `POST /public/doppler/build-transfer-beneficiary` → user signs returned `to`/`data`.

`newBeneficiary` must be the **canonical escrow** address (see table above for this deploy).

---

## List BFRR for sale (seller — after you hold the receipt)

**Collection** is always the **BFRR** contract (`BankrFeeRightsReceipt`). **`tokenId`** is the receipt id (uint256). **`priceWei`** is the ask in **wei** (1 ETH = `1000000000000000000`). There is **no** USDC path in this MVP — **ETH only**.

1. **Choose price in ETH** → convert to wei (e.g. `1.5` ETH → `1500000000000000000`). Double-check decimals: **18** for native ETH in `priceWei`.
2. **Approve** the marketplace to move your NFT (one-time per collection is enough with `setApprovalForAll`):

```text
Send transaction to 0xB9E56dA4B83e77657296D7dE694754bd8b7d00db on Base calling
setApprovalForAll(0xA8163A62030a74F946eC73422EE692efE68AFE0B, true)
```

(Use the canonical BFRR + `FeeRightsFixedSale` addresses from the table above if unchanged.)

3. **`list`** — locks the NFT in the marketplace contract until `buy` or `cancel`:

```text
Send transaction to 0xA8163A62030a74F946eC73422EE692efE68AFE0B on Base calling
list(
  0xB9E56dA4B83e77657296D7dE694754bd8b7d00db,
  <tokenId>,
  <priceWei>
)
```

Returns / emits a **`listingId`** (see `Listed` on BaseScan). Tell the user to **save `listingId`** for buyers.

**Cancel listing:** seller calls `cancel(listingId)` on the same marketplace — NFT returns to seller (does **not** burn BFRR; that is different from escrow `cancelRights`).

---

## Buy BFRR that is listed (buyer)

1. **Get `listingId`** — from marketplace UI, `Listed` events on `FeeRightsFixedSale`, or ask the seller. Optionally **verify on-chain** before paying:

   - Call **`getListing(listingId)`** on the marketplace — check **`active`**, read **`priceWei`**, **`collection`**, **`tokenId`**, **`seller`**.

2. **Pay exactly `priceWei` ETH** in the same transaction as `buy`:

```text
Send transaction to 0xA8163A62030a74F946eC73422EE692efE68AFE0B on Base
with value <priceWei> wei
calling buy(<listingId>)
```

**Critical:** `msg.value` must **equal** `listing.priceWei` exactly or the contract reverts **`WrongPayment`**. If the listing was cancelled or sold, **`ListingInactive`**.

3. After success, the buyer **holds the BFRR** in their wallet; **redemption / fee claims** still go through **`BankrEscrowV3`** per receipt rules (not covered in one tx here).

---

## Marketplace read helpers (agent / support)

| Call | Purpose |
|------|---------|
| `getListing(listingId)` | `collection`, `tokenId`, `seller`, `priceWei`, `active` |
| `nextListingId()` | Upper bound; scan `Listed` logs or app index for open listings |

---

## List / buy reverts (`FeeRightsFixedSale`)

| Revert | Meaning |
|--------|---------|
| `WrongPayment` | `buy`: `msg.value` ≠ listed `priceWei` |
| `ListingInactive` | `buy` / `cancel`: no active listing for that id |
| `AlreadyListed` | `list`: asset already has an active listing |
| `ZeroPrice` | `list`: `priceWei` must be > 0 |
| `NotSeller` | `cancel`: caller is not listing seller |

---

## Agent rules of thumb

1. **Resolve** `feeManager`, `poolId`, `token0`, `token1` from app metadata or Bankr/Doppler public reads — **never guess** hex.
2. **Never** instruct users to rely on **pasting** transaction JSON as the only broadcast path; align with **mini-app `confirmTransaction`** and show **tx hash** + BaseScan after submit.
3. **Gate** steps on **receipts** + contract reads (`pendingSeller`, escrow `getShares`, beneficiary reads consistent with finalize checks).
4. For **orchestration**: tell builders to treat **“sell rights + list at X ETH”** as one **job** in the app (queued txs + receipts + one summary confirm listing all side effects); chat skill is **supplemental**.

---

## Links

- **Repo:** [github.com/anondevv69/bankrtokennft](https://github.com/anondevv69/bankrtokennft)
- **Escrow (BaseScan):** [0xFb28…d95F](https://basescan.org/address/0xfb28d9c636514f8a9d129873750f9b886707d95f)
- **BFRR (BaseScan):** [0xB9E5…00db](https://basescan.org/address/0xb9e56da4b83e77657296d7de694754bd8b7d00db)
- **Marketplace (BaseScan):** [0xA816…FE0B](https://basescan.org/address/0xa8163a62030a74f946ec73422ee692efe68afe0b)
- **Install skills in Bankr:** [Install a Skill from GitHub](https://docs.bankr.bot/skills/in-bankr/from-github/)

Install line (folder URL):

```text
install the skill at https://github.com/anondevv69/bankrtokennft/tree/main/fee-rights-exchange/skills/bankr-fee-rights
```

---

## Install note

Bankr expects a **public** GitHub folder URL whose root contains **`SKILL.md`** ([docs](https://docs.bankr.bot/skills/in-bankr/from-github/)). This folder is **`fee-rights-exchange/skills/bankr-fee-rights/`** in the repo above.
