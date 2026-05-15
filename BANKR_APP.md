# Bankr App (Apps SDK) — fee-rights marketplace

The **in-Bankr** experience is a [Bankr App](https://docs.bankr.bot/apps/sdk): `index.html`, optional `scripts/`, and manifest permissions for chain + transactions.

## Contracts (this repo)

- **`BankrEscrowV3`:** `prepareDeposit(feeManager, poolId, token0, token1)` → selector `0x6ac71ccc`; then beneficiary must point at escrow; then seller calls `finalizeDeposit`.
- **`BankrFeeRightsReceipt`:** minted on finalize.
- **`FeeRightsFixedSale`:** list / buy / cancel / offers — see `bankr-app/` for a **standalone** wagmi demo only.

## Transactions

- Use **`encodeFunctionData`** and pass a raw **`0x…`** string into **`bankr.tx.prepare`** / **`confirmTransaction`** (do not stringify calldata objects in a way that breaks hex).
- Button flows should **not** rely on chat JSON alone; use the SDK confirm path and **await receipts** before advancing wizards.

## Seller: fee beneficiary → escrow

Prefer **Bankr’s beneficiary transfer APIs** instead of “open Doppler and paste.” Full checklist (API paths, gating, escrow address): **`LAUNCH_CHECKLIST.md`** → section *Bankr Marketplace seller step — fee beneficiary → escrow*.

Official API overview: [Transferring fees to a new wallet](https://docs.bankr.bot/token-launching/transferring-fees).

## Ask Bankr (agent skill)

For chat/support, install the public skill from this repo (see [Install a Skill from GitHub](https://docs.bankr.bot/skills/in-bankr/from-github/)):

```text
install the skill at https://github.com/anondevv69/bankrtokennft/tree/main/fee-rights-exchange/skills/bankr-fee-rights
```

Source: **`skills/bankr-fee-rights/SKILL.md`** and **`skills/bankr-fee-rights/references/dm-intents.md`** (copy-paste blocks for DMs). The mini-app still owns **orchestrated** sell flows; the skill guides **structured** agent prompts and troubleshooting. Re-run the install line above after skill updates so Bankr refreshes the skill.

**Mirror or test Bankr web against this repo:** give the agent GitHub access, install the skill above, then paste the one-liner from **`BANKR_AGENT_REPO_INDEX.md`** (repo root). That file orders the docs to read and points to **`bankr-app/src/App.tsx`** / **`EscrowWizard.tsx`** as the current standalone UX reference (listings, search, wizard steps).

## Wallet signers (Bankr vs external)

**Bankr Marketplace (mini-app):** Prefer **two modes** so sellers are not blocked when a custodial **security scanner** lags behind **BaseScan verification**:

1. **Bankr account / embedded wallet** — smooth onboarding; signing may be gated by Bankr’s risk engine for **`approve`** to new marketplace deployments.  
2. **External wallet (WalletConnect / MetaMask / Rabby)** — user signs **`approve` + `list`** directly; no custodial scanner on those txs (still only offer **canonical** `FeeRightsFixedSale` + verified BFRR addresses).

**Orchestration:** always **`approve` (or `setApprovalForAll`) → `list`**; never **`list`** alone. Use **full** BFRR **`tokenId`** = `escrow.tokenIdFor(feeManager, poolId)` in calldata — do not truncate.

Details and escalation: **`INTEGRATION_NOTES.md`**, **`LAUNCH_CHECKLIST.md`** (verification + section 5, Bankr Marketplace).

## Standalone web

For browser-wallet-only demos and Railway: **`bankr-app/README.md`**.
