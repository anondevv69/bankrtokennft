Minimal Base Sepolia UI for `FeeRightsFixedSale`: **sell at a price or cancel**, **offers** (send, pull back, accept), **buy** a listing. Hardcoded to **Base Sepolia (84532)** only — wrong network shows a gate and blocks reads/writes from this UI.

## Node version

Use **Node 20 LTS** (see `package.json` `engines` and `nixpacks.toml`). Railway picks this up via `NIXPACKS_NODE_VERSION`.

## Security (Railway and everywhere)

Do **not** set `PRIVATE_KEY`, deployer secrets, or escrow owner keys in Railway or any `VITE_*` / frontend env. This app is **wallet-only**: users sign in the browser. Anything that can move funds belongs in a secure backend or Foundry on your machine — not here.

## Local dev vs public hosting

- **`npm run dev`** — Vite dev server on **your computer only** (`http://localhost:5174`). Nothing is “hosted” on the internet; it is for building and testing while you code.
- **`npm run build`** — Produces static files in **`dist/`** (HTML/JS/CSS). To give other people a URL, deploy **`dist`** (or let a platform build it for you).

You do **not** need Railway (or any host) to develop locally. You **do** need a host if you want a stable public link (e.g. for Bankr teammates or a staging demo).

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

Opens on port **5174** by default.

### Vite env vars (important for deploys)

`VITE_*` variables are baked in at **`npm run build`** time. On Railway (or any CI), define `VITE_MARKETPLACE_ADDRESS` (and optional `VITE_DEFAULT_RECEIPT_COLLECTION`, `VITE_RPC_URL`) in the service **before** the build step runs, then trigger a rebuild when you change them.

`VITE_CHAIN_ID` is **documented for operators only** — this MVP build is hardcoded to Base Sepolia `84532` in `src/chain.ts` and `src/wagmi.ts`. If you set another value, it is ignored and a console warning is printed.

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
   - `VITE_MARKETPLACE_ADDRESS` = your deployed `FeeRightsFixedSale` on Base Sepolia  
   - Optionally `VITE_DEFAULT_RECEIPT_COLLECTION` = `BankrFeeRightsReceipt` address  
   - Optionally `VITE_RPC_URL` = `https://sepolia.base.org` (or your RPC)  
   - Optionally `VITE_CHAIN_ID=84532` (documentation parity only)

After deploy, open the public URL. The UI shows a **testnet banner** and refuses other chains when a wallet is connected.

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
