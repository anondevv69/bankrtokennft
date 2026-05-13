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

## Standalone web

For browser-wallet-only demos and Railway: **`bankr-app/README.md`**.
