# Bankr app (web)

Minimal Base Sepolia UI for `FeeRightsFixedSale`: connect wallet, read aggregate and personal offers, place or withdraw offers, approve collection, list / cancel / buy, and accept a bid.

## Local dev vs public hosting

- **`npm run dev`** — Vite dev server on **your computer only** (`http://localhost:5174`). Nothing is “hosted” on the internet; it is for building and testing while you code.
- **`npm run build`** — Produces static files in **`dist/`** (HTML/JS/CSS). To give other people a URL, deploy **`dist`** (or let a platform build it for you).

You do **not** need Railway (or any host) to develop locally. You **do** need a host if you want a stable public link (e.g. for Bankr teammates or a staging demo).

## Setup

```bash
cd bankr-app
npm install
```

Copy `.env.example` to `.env` and set addresses when you have them (see **Next steps** below).

```bash
npm run dev
```

Opens on port **5174** by default.

### Vite env vars (important for deploys)

`VITE_*` variables are baked in at **`npm run build`** time. On Railway (or any CI), define `VITE_MARKETPLACE_ADDRESS` (and optional `VITE_DEFAULT_RECEIPT_COLLECTION`, `VITE_RPC_URL`) in the service **before** the build step runs, then trigger a rebuild when you change them.

## Build

```bash
npm run build
npm run preview
```

## Deploy on Railway (optional)

1. New **Railway** project → **Deploy from GitHub** → pick this repo.
2. Set **Root Directory** to `bankr-app` (monorepo subfolder).
3. In **Variables**, add at least:
   - `VITE_MARKETPLACE_ADDRESS` = your deployed `FeeRightsFixedSale` on Base Sepolia  
   - Optionally `VITE_DEFAULT_RECEIPT_COLLECTION` = `BankrFeeRightsReceipt` address  
   - Optionally `VITE_RPC_URL` = `https://sepolia.base.org` (or your RPC)
4. Railway will run `npm install` and needs a **build** + **start**:
   - **Build command:** `npm run build`
   - **Start command:** `npm start` (serves `dist/` on `PORT`)

After deploy, open the generated public URL. Wallets must still use **Base Sepolia** (chain 84532).

## Next steps to “wire up” the Bankr app

1. **Deploy `FeeRightsFixedSale`** to Base Sepolia (if you have not yet): from repo root, `forge script script/DeployFeeRightsFixedSale.s.sol` with `--broadcast`, then note the contract address.
2. **Receipt collection address** — same chain: your `BankrFeeRightsReceipt` deployment (from `DeployBankrEscrowV3` output or your records).
3. **Put addresses in env** — locally copy `bankr-app/.env.example` → `bankr-app/.env` and set `VITE_MARKETPLACE_ADDRESS` and `VITE_DEFAULT_RECEIPT_COLLECTION`. Restart `npm run dev`.
4. **In the UI** — paste marketplace + receipt + token ID; connect MetaMask (or any injected wallet) on **Base Sepolia**; then offers / list / buy flows talk to real contracts.

Escrow flows (`prepareDeposit`, `finalizeDeposit`, `redeemRights`) still go through **`BankrEscrowV3`** on-chain; this app only drives the **marketplace** contract today. Extending the same app for escrow is a separate UI + ABI slice when you are ready.

The ABI is checked in under `src/lib/feeRightsFixedSaleAbi.ts`. After changing Solidity, regenerate:

```bash
cd ..   # fee-rights-exchange root
forge build
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('out/FeeRightsFixedSale.sol/FeeRightsFixedSale.json','utf8'));fs.writeFileSync('bankr-app/src/lib/feeRightsFixedSaleAbi.ts','export const feeRightsFixedSaleAbi = '+JSON.stringify(j.abi,null,2)+' as const;\\n');"
```
