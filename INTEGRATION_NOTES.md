# Integration Notes

Track real Base Sepolia / Bankr behavior here. Do not record private keys, seed phrases, or sensitive wallet metadata.

## Deployment

- Network: Base Sepolia
- Escrow: `0xFb28D9C636514f8a9D129873750F9b886707d95F`
- Owner: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Deploy tx: `0xcdf9d0e9f8a69a2fc356ac3cf99df1ce8b6e4eff4aa9b6f75283c8fc67b79352`

## Test Case Template

### Test: prepare -> transfer -> finalize

- Date:
- Token:
- Fee manager:
- Pool ID:
- Seller wallet:
- Escrow wallet/contract:
- Starting seller share:
- Starting escrow share:
- Transaction hashes:
  - `prepareDeposit`:
  - Bankr `updateBeneficiary` to escrow:
  - `finalizeDeposit`:
- Final seller share:
- Final escrow share:
- Notes:

### Test: claim fees while escrowed

- Date:
- Token:
- Fee manager:
- Pool ID:
- Claimable before:
- `claimFees` tx:
- `accruedFees0` after:
- `accruedFees1` after:
- Actual received assets/balances:
- Notes:

### Test: cancel rights

- Date:
- Token:
- Fee manager:
- Pool ID:
- Seller wallet:
- Escrow share before:
- Seller share before:
- `cancelRights` tx:
- Escrow share after:
- Seller share after:
- Local escrow state cleared:
- Notes:

### Test: release rights

- Date:
- Token:
- Fee manager:
- Pool ID:
- Recipient wallet:
- Escrow share before:
- Recipient share before:
- `releaseRights` tx:
- Escrow share after:
- Recipient share after:
- Local escrow state cleared:
- Notes:

## Bankr Marketplace — custodial wallet vs external wallet (mainnet)

**Bankr-embedded / custodial wallet (e.g. in-app `0x374d…`):** Bankr’s **security scanner** may block **`approve` / `setApprovalForAll`** on **`FeeRightsFixedSale`** (`0xA816…`) until a **third-party risk index** ingests **BaseScan +/or Sourcify** verification — even when the contract is already **verified on BaseScan**. Escalate false positives with Bankr support if the block lasts **>24h** after public verification.

**External wallet (MetaMask / Rabby / WalletConnect):** txs are signed by the **user’s** wallet client — **no** Bankr custodial scanner on those **`approve`/`list`** calls. Recommended **MVP escape hatch** when custodial signing is blocked: Bankr broadcasts **`safeTransferFrom(BFRR, bankrWallet → userEOA, tokenId)`** (often allowed), then the user **`approve` + `list`** from the EOA with **gas**.


### Gamal support — Bankr mini-app transaction flow (May 2026)

Per Bankr support (**Gamal**): **`/wallet/submit`** with **raw calldata** is **always blocked** for custodial safety (the pipeline cannot verify arbitrary data). Integrations must use the **`prepare:transaction`** permission so the app **builds** the tx and the user **confirms** in Bankr chat (or the product’s confirm step). Also verify the **app manifest** lists **Base (`8453`)** and the correct **permissions** for the contracts you touch. If you already use **`prepare:transaction`**, the target contract is **verified on BaseScan**, and the scanner still blocks (e.g. **`approve`** to **`FeeRightsFixedSale`**), escalate as a **false positive** / risk-index issue — see **§2** under *Recurring failure modes* below.

**BFRR `tokenId`:** always **`uint256 = escrow.tokenIdFor(feeManager, poolId)`** — not raw `poolId` as `ownerOf` input. **`BankrFeeRightsReceipt`** is **not** `ERC721Enumerable` — no `tokenOfOwnerByIndex` on-chain.

**`isEscrowed(poolId)` on escrow** and **`ownerOf(tokenId)` on BFRR** answer **different** questions — both can be “active” after finalize (seller holds receipt NFT; escrow holds the fee-rights position for the pool).

### FeeRightsFixedSale listing — binary state (no fuzzy “optional list”)

On-chain reality for **`FeeRightsFixedSale`**:

- **Not for sale:** Seller **holds** BFRR in their wallet; no **active** listing for that `(collection, tokenId)` on the marketplace.  
- **For sale:** Seller called **`list`** → BFRR is **held by the marketplace contract** until **`buy`** or **`cancel`**; then it goes to buyer or back to seller.

There is **no** third “optional / in-between” listing state. **Update (Bankr `bankr-marketplace-v1` v1.62, May 2026):** Bankr shipped **split flows** — **mint receipt** (3 steps) vs **sell rights** (4 steps) — **required listing** with enforced price, and removed **“Optional”** / **“0 to skip”** labels. **Follow-up (v1.62 / internal v144):** **`poolId`** passed as full **32-byte** hex to fix viem **bytes31 vs bytes32**; worker injects full tuple **`feeManager`, `poolId`, `token0`, `token1`** before **`prepareDeposit`** (incl. “test” launch); **List only** when wallet already holds BFRR — direct action under **MANAGE** tab (skips escrow + mint); sell flow uses **`approve(marketplace, tokenId)`**. Custodial scanner manual refresh for marketplace + BFRR: vendor index ETA was quoted **~5–10 minutes** after push — re-try custodial **`approve`** after that window. **Further patch (Bankr ack):** `cleanPoolId` / strict **`bytes32`** sanitization in **`prepareDeposit`**, **`checkEscrowStatus`**, **`prepareFinalizeDeposit`**, and **Quick list** in **`prepareList.ts`** — prior **bytes33** errors were app-side padding; canonical **`poolId`** for the token was verified **32-byte** on their side. Marketplace may still show **`unverified_contract`** until vendor index clears; **`safeTransferFrom` → EOA** remains the fast path if needed.

## Recurring failure modes (May 2026)

### 1 — `poolId` 33 bytes (66 hex chars) in calldata

**Symptom:** Bankr reports viem "bytes33 vs bytes32" OR on-chain revert before `prepareDeposit` executes. The bad segment looks like `abcdef1234…0000` — either a placeholder or a production pool id that got one extra byte appended/padded.

**Root cause:** Worker encodes `poolId` before stripping or sanitizing. Common sub-causes:
- Canonical API returns 32-byte hex; worker concatenates a padding `00` or a trailing nybble from another field.
- Placeholder `0xabcdef…` used instead of the real 32-byte pool id from `token-fees` API.
- `cleanPoolId` / strict `bytes32` guard not applied at the final encode step (only applied upstream).

**Fix:** Before every `prepareDeposit` encoding, assert `poolId.replace("0x","").length === 64`. Log: (1) raw value from API, (2) length, (3) final value fed to `encodeAbiParameters`. All three must be 64 hex chars. Use `0x` + exactly 64 hex, no padding.

### 2 — Bankr custodial scanner flags `FeeRightsFixedSale` as dangerous / malicious

**Symptom:** `approve` or `setApprovalForAll` (BFRR → `0xA816…`) is blocked by Bankr with an "unverified / malicious" or "dangerous contract" warning — even after BaseScan + Sourcify verification.

**Root cause:** Bankr's custodial wallet routes ERC-20/NFT approvals through a **third-party risk index** (likely GoPlus Security or similar). Newly deployed contracts have **no reputation score** in that index regardless of BaseScan status. The scanner returns a "high risk" flag → Bankr blocks the tx as a safety measure. This is **not** a contract bug; it is a **reputation cold-start** problem.

**Workarounds (in order of speed):**
1. **Wait** — index typically updates within minutes to hours after a Sourcify + BaseScan verification push. Re-try `approve` after that window.
2. **Escalate** — contact Bankr support with BaseScan verified URL + the contract address; request manual whitelist refresh.
3. **External wallet escape hatch** — Bankr broadcasts `safeTransferFrom(BFRR, bankrCustodialWallet → userEOA, tokenId)` (no scanner on NFT transfers in most configurations), then user opens MetaMask / Rabby / WalletConnect and calls `approve(0xA816…, tokenId)` + `list(…)` themselves with gas from their EOA.

### 3 — MVP design: sell → cancel → fee rights return

The user-intended flow matches the contracts exactly:

| Step | Contract call | What happens |
|------|--------------|--------------|
| List at fixed price | `FeeRightsFixedSale.list(BFRR, tokenId, priceWei)` | BFRR held by marketplace; seller gets ETH if sold |
| Cancel listing | `FeeRightsFixedSale.cancel(listingId)` | BFRR returned to seller wallet |
| Reclaim fee beneficiary | `BankrEscrowV3.redeemRights(tokenId)` | BFRR burns; escrow calls `updateBeneficiary(poolId, seller)` → fee rights back |
| Someone buys | `FeeRightsFixedSale.buy(listingId)` w/ exact ETH | BFRR to buyer; ETH to seller |

**Important:** `cancel` on `FeeRightsFixedSale` only returns the BFRR NFT — **fee rights are still escrowed** in `BankrEscrowV3`. The seller must then call `redeemRights(tokenId)` on the escrow to actually reinstate themselves as fee beneficiary. If they just want to re-list later, they can hold the BFRR and `list` again without another escrow cycle.

## Observations

- Ownership propagation:
- Share accounting behavior:
- Fee timing behavior:
- Unexpected reverts:
- Gas usage:
- Bankr API/on-chain read differences:
- Follow-up contract changes needed:
