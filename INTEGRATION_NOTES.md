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

**BFRR `tokenId`:** always **`uint256 = escrow.tokenIdFor(feeManager, poolId)`** — not raw `poolId` as `ownerOf` input. **`BankrFeeRightsReceipt`** is **not** `ERC721Enumerable` — no `tokenOfOwnerByIndex` on-chain.

**`isEscrowed(poolId)` on escrow** and **`ownerOf(tokenId)` on BFRR** answer **different** questions — both can be “active” after finalize (seller holds receipt NFT; escrow holds the fee-rights position for the pool).

### FeeRightsFixedSale listing — binary state (no fuzzy “optional list”)

On-chain reality for **`FeeRightsFixedSale`**:

- **Not for sale:** Seller **holds** BFRR in their wallet; no **active** listing for that `(collection, tokenId)` on the marketplace.  
- **For sale:** Seller called **`list`** → BFRR is **held by the marketplace contract** until **`buy`** or **`cancel`**; then it goes to buyer or back to seller.

There is **no** third “optional / in-between” listing state. **Update (Bankr `bankr-marketplace-v1` v1.62, May 2026):** Bankr shipped **split flows** — **mint receipt** (3 steps) vs **sell rights** (4 steps) — **required listing** with enforced price, and removed **“Optional”** / **“0 to skip”** labels. **Follow-up (v1.62 / internal v144):** **`poolId`** passed as full **32-byte** hex to fix viem **bytes31 vs bytes32**; worker injects full tuple **`feeManager`, `poolId`, `token0`, `token1`** before **`prepareDeposit`** (incl. “test” launch); **List only** when wallet already holds BFRR — direct action under **MANAGE** tab (skips escrow + mint); sell flow uses **`approve(marketplace, tokenId)`**. Custodial scanner manual refresh for marketplace + BFRR: vendor index ETA was quoted **~5–10 minutes** after push — re-try custodial **`approve`** after that window.

## Observations

- Ownership propagation:
- Share accounting behavior:
- Fee timing behavior:
- Unexpected reverts:
- Gas usage:
- Bankr API/on-chain read differences:
- Follow-up contract changes needed:
