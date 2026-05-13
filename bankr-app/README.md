# Bankr app (web)

Minimal **Base mainnet** UI for `FeeRightsFixedSale`: **sell at a price or cancel**, **offers** (send, pull back, accept), **buy** a listing — for real Bankr receipt NFTs. Hardcoded to **Base (chain id 8453)** only; wrong network shows a gate and blocks reads/writes from this UI.

## Node version

Use **Node 20 LTS** (see `package.json` `engines` and `nixpacks.toml`). Railway picks this up via `NIXPACKS_NODE_VERSION`.

## Security (Railway and everywhere)

Do **not** set `PRIVATE_KEY`, deployer secrets, or escrow owner keys in Railway or any `VITE_*` / frontend env. This app is **wallet-only**: users sign in the browser. Anything that can move funds belongs in a secure backend or Foundry on your machine — not here.

## Local dev vs public hosting

- **`npm run dev`** — Vite dev server on **your computer only** (`http://localhost:5174`). Nothing is “hosted” on the internet; it is for building and testing while you code.
- **`npm run build`** — Produces static files in **`dist/`** (HTML/JS/CSS). To give other people a URL, deploy **`dist`** (or let a platform build it for you).

You do **not** need Railway (or any host) to develop locally. You **do** need a host if you want a stable public link.

## Production build check

```bash
npm run verify
```

Runs `npm run build` and confirms `dist/index.html` exists (use in CI or before shipping).

## Setup

```bash
cd bankr-app
npm install
```

Copy `.env.example` to `.env` and set addresses when you have them (see **Next steps** below).

```bash
npm run dev
```

Opens on port **5174** by default. Your wallet must be on **Base mainnet** to transact.

### Vite env vars (important for deploys)

`VITE_*` variables are baked in at **`npm run build`** time. On Railway (or any CI), define `VITE_MARKETPLACE_ADDRESS` (and optional `VITE_DEFAULT_RECEIPT_COLLECTION`, `VITE_RPC_URL`) in the service **before** the build step runs, then trigger a rebuild when you change them.

`VITE_CHAIN_ID` is **documented for operators only** — this MVP build is hardcoded to Base mainnet **8453** in `src/chain.ts` and `src/wagmi.ts`. If you set another value, it is ignored and a console warning is printed.

Use a **dedicated Base RPC** (`VITE_RPC_URL`) in production; the default public endpoint is convenient for dev but can be rate-limited.

## Build

```bash
npm run build
npm run preview
```

## Deploy on Railway

1. New **Railway** project → **Deploy from GitHub** → pick this repo.
2. Set **Root Directory** to `bankr-app` (monorepo subfolder).
3. **Nixpacks:** this folder includes `nixpacks.toml` (Node 20, `npm ci`, `npm run build`, `npm start`). If Railway does not pick it up, set **Custom Build Command** to `npm run build` and **Start Command** to `npm start`.
4. In **Variables**, add at least:
   - `VITE_MARKETPLACE_ADDRESS` = your deployed `FeeRightsFixedSale` on **Base**  
   - Optionally `VITE_DEFAULT_RECEIPT_COLLECTION` = `BankrFeeRightsReceipt` on **Base**  
   - **Recommended:** `VITE_RPC_URL` = your provider URL for Base mainnet  
   - Optionally `VITE_CHAIN_ID=8453` (documentation parity only)

After deploy, open the public URL. The UI shows a **Base mainnet** banner and refuses other chains when a wallet is connected.

## Next steps to wire the Bankr app

1. **Deploy contracts to Base** (mainnet) when ready — use your RPC and Foundry `forge script … --rpc-url <BASE_MAINNET> --broadcast` (same repo scripts; point RPC at Base, not Sepolia).
2. **Addresses** — `FeeRightsFixedSale` + `BankrFeeRightsReceipt` (and escrow) on **Base**.
3. **Env** — copy `bankr-app/.env.example` → `bankr-app/.env`; set `VITE_MARKETPLACE_ADDRESS`, `VITE_DEFAULT_RECEIPT_COLLECTION`, and preferably `VITE_RPC_URL`. Restart `npm run dev`.
4. **In the UI** — connect a wallet on **Base**; enter marketplace, receipt contract, and token id.

Escrow flows (`prepareDeposit`, `finalizeDeposit`, `redeemRights`) still go through **`BankrEscrowV3`** on-chain; this app only drives the **marketplace** contract today.

The ABI is checked in under `src/lib/feeRightsFixedSaleAbi.ts`. After changing Solidity, regenerate:

```bash
cd ..   # fee-rights-exchange root
forge build
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('out/FeeRightsFixedSale.sol/FeeRightsFixedSale.json','utf8'));fs.writeFileSync('bankr-app/src/lib/feeRightsFixedSaleAbi.ts','export const feeRightsFixedSaleAbi = '+JSON.stringify(j.abi,null,2)+' as const;\\n');"
```
