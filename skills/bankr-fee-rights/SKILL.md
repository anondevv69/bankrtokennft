---
name: bankr-fee-rights
description: Bankr Fee Rights Receipts (BFRR) on Base — escrow prepare/finalize, fee beneficiary to escrow, list/buy, allowlist fee managers, resolve correct fee manager for getShares, DM-friendly sell/buy intents. Use when the user sells or buys fee rights, DMs Bankr to list a token, prepareDeposit reverts, allowedFeeManager, wrong fee manager, beneficiary order, listingId, or BankrEscrowV3 vs FeeRightsFixedSale confusion.
tags: [bankr, base, bfrr, escrow, doppler, defi]
version: 7
metadata:
  clawdbot:
    emoji: "🧾"
    homepage: "https://github.com/anondevv69/bankrtokennft/tree/main/fee-rights-exchange/skills/bankr-fee-rights"
---

# Bankr Fee Rights (BFRR) — Base mainnet

Guidance for agents helping users with **Bankr fee rights** custody, **BFRR** receipts, and **FeeRightsFixedSale** listings on **Base (chain id 8453)**.

**Primary UX:** the **Bankr Marketplace mini-app** should orchestrate txs (queued steps + receipts + one summary confirm). This skill supports **DMs / Ask Bankr / support** so users can still succeed with **structured facts** when the app is wrong or unavailable — **do not** treat pasted raw JSON as the only execution path; prefer **structured** “send transaction … calling …” instructions (see [QR Coin skill pattern](https://github.com/BankrBot/skills/blob/main/qrcoin/SKILL.md)).

**DM templates** (what to ask the user for in one message): see **`references/dm-intents.md`**.

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

## On-chain flow (order matters — do not invert)

**Hard rule:** **`prepareDeposit` comes before moving the fee beneficiary to the escrow address.**  
`prepareDeposit` checks **`getShares(poolId, msg.sender) > 0`** on the **fee manager** while the **seller still holds** the on-chain position. If beneficiary is already pointed at escrow first, the seller may show **`getShares = 0`** and **`prepareDeposit` fails** — that is a **ordering bug**, not “register first.”

1. **`prepareDeposit(feeManager, poolId, token0, token1)`** on **Escrow** — pending seller = `msg.sender`; **`getShares(poolId, msg.sender) > 0`** on **`feeManager`**.
2. **Fee beneficiary → escrow** — `newBeneficiary` = escrow. Bankr APIs need a valid **`tokenAddress`** (the **launched token**, e.g. t4), or **`build-transfer-beneficiary`** returns `Valid tokenAddress required`. See [Transferring fees](https://docs.bankr.bot/token-launching/transferring-fees).
3. **`finalizeDeposit(poolId)`** — seller only; escrow must hold shares; mints **BFRR**.
4. **List / buy** — **`FeeRightsFixedSale`** (different contract from escrow): approve + **`list`**; **`buy(listingId)`** with exact **`msg.value`**.

Never tell the user **“success”** until the matching tx **mined** and reads match (e.g. `pendingSeller`, shares on escrow).

---

## Fee manager resolution (most common production bug)

- The **`feeManager`** argument to **`prepareDeposit`** must be the **same on-chain contract** where **`getShares(bytes32 poolId, address beneficiary)`** is defined for that pool — typically the same target **`build-transfer-beneficiary`** uses for that **launched token**.
- **`getShares` that reverts** on `eth_call` usually means **wrong `feeManager` address or invalid pool for that contract** — **not** the same as “shares are zero.” **`0`** returned (no revert) means no position for that wallet on **that** manager.
- **`GET /public/doppler/token-fees/:tokenAddress`** returns **`poolId`** and beneficiary **`address`** / **`share`** in some responses — it may **not** include the **initializer / fee manager**; resolve that from the **same internal registry** the product uses for beneficiary transfers, not guesses.

---

## Escrow allowlist (owner, once per manager contract)

- **`setFeeManagerAllowed(feeManager, bool)`** on escrow — **`onlyOwner`**. Not `allowFeeManager`.
- **Per fee manager contract address**, not per user wallet. New sellers reuse the same allowlisted manager.
- Deploy-time: set **`INITIAL_FEE_MANAGERS`** CSV in **`DeployBankrEscrowV3`** so allowlist is included in the deploy broadcast.

---

## Common agent mistakes (do not repeat)

| Wrong advice | Why it’s wrong |
|--------------|----------------|
| Approve **WETH** to **`0xFb28…`** for **`prepareDeposit`** | **`prepareDeposit`** is **`value: 0`**; it does not spend user WETH. |
| Call **`0xFb28…` the “marketplace”** | **Listings** are **`FeeRightsFixedSale`** (`0xA816…`). **`0xFb28…`** is **escrow** (`BankrEscrowV3`). |
| “Move beneficiary to escrow **before** prepare so shares exist” | **Inverted order** — see section above. |
| “`getShares` reverted ⇒ user has no position” | **Revert ⇒ wrong target / ABI**, until proven otherwise. Off-chain **token-fees** may still show **share %** for the user. |
| **`balanceOf`** on fee manager for shares | Use **`getShares(poolId, address)`** per **`IBankrFees`**. |
| “User can **`approve`** marketplace as soon as BaseScan verifies” | **Bankr-custodial** wallets may still block until a **third-party scanner index** updates — sometimes **24h+**; offer **WalletConnect / MetaMask** or **`safeTransferFrom`** BFRR to user EOA. See **`INTEGRATION_NOTES.md`**. |

---

## Custodial scanner vs listing (Bankr marketplace)

- **`list`** on **`FeeRightsFixedSale`** requires prior **`approve`/`setApprovalForAll`** on **BFRR** for the marketplace address — **two** txs (or a deliberate multicall), not one magic **`list`**.  
- If **`approve`** is blocked with **`unverified_contract`** despite **BaseScan** verification: **Sourcify** + **wait**; **escalate** with Bankr if **>24h**; recommend **external wallet login** or **NFT transfer to user EOA** for **`approve` + `list`**.

---

## `prepareDeposit` encoding (critical)

- **Function:** `prepareDeposit(address feeManager, bytes32 poolId, address token0, address token1)`
- **Selector:** `0x6ac71ccc` (**four** arguments only — not a five-argument overload.)
- **Chain:** Base mainnet (`8453`).

### Example (t4-style pool — **verify `feeManager` before use**)

Illustrative only — **`feeManager` must match on-chain reality** for that token (see **Fee manager resolution**). Example tuple: poolId `0xc4db87d196ba3cdc05950eeec2d35de8cf76fb81cde996a5613682e99808cc8f`, token0 WETH `0x4200000000000000000000000000000000000006`, token1 `0xfc8ff3050def72b18083b119ce0cecab86b43ba3`.

Structured prompt for Bankr (substitute **verified** `feeManager`):

```text
Send transaction to 0xFb28D9C636514f8a9D129873750F9b886707d95F on Base calling
prepareDeposit(
  <VERIFIED_FEE_MANAGER>,
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

**Product rule:** **`FeeRightsFixedSale`** is **binary**: either the BFRR is **actively listed** (NFT in marketplace custody until **`buy`** or **`cancel`**) or **not listed** (seller holds BFRR). There is no meaningful “optional listing” step inside one Sell wizard — that confuses users. If the flow is branded **“Sell rights + list”** (listing is in scope), **require a positive ETH price** before starting; **do not** label **`list` as Optional** or “0 to skip.” Use a **separate** **“Receipt only”** path with **no** `list` when users only want BFRR. On-chain **`list` reverts with `ZeroPrice` if `priceWei == 0`**.

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

1. **Resolve** `feeManager`, `poolId`, `token0`, `token1` from the **same pipeline** as production beneficiary tooling — **never hardcode** a fee manager unless **`getShares`** returns cleanly for that wallet + pool.
2. **Never** instruct users to rely on **pasting** transaction JSON as the only broadcast path; align with **mini-app `confirmTransaction`** and show **tx hash** + BaseScan after submit.
3. **Gate** steps on **receipts** + contract reads (`pendingSeller`, shares on escrow for finalize).
4. **DMs:** ask for the **structured block** in **`references/dm-intents.md`** so one thread can drive **sell** or **buy** without back-and-forth guessing.
5. For **orchestration**: builders should treat **“sell rights + list at X ETH”** as one **job** (queued txs + receipts + one summary confirm); this skill stays **supplemental** for humans and agents.

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
