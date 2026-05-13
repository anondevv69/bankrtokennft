# Railway — Bankr web app

## Why you saw `Cannot find module '/app/index.js'`

Railway was treating the **repo root** as a Node app. The root `package.json` used to declare `"main": "index.js"`, but **no such file exists**, so Node crashed.

**Fix in the repo (already done):**

- Removed the bogus `main` entry.
- Added root scripts **`npm run build`** → builds `bankr-app` (`cd bankr-app && npm install && npm run build`).
- Added root **`npm start`** → serves the Vite output (`cd bankr-app && npm start`).

So you can deploy **either**:

1. **Repo root** (default clone) — Railway runs root `npm install`, `npm run build`, `npm start`, **or**
2. **Service root directory `bankr-app`** only — then Railway uses `bankr-app`’s own `package.json` (original setup).

Do **not** mix: if you set root to `bankr-app`, do **not** rely on the parent `package.json` scripts.

**Custom start command:** should be `npm start` (or leave empty if Nixpacks detects it). **Do not** use `node index.js`.

---

## Variables — what belongs in Railway

### Put these on the **frontend** service (Bankr app)

| Name | Value |
|------|--------|
| `VITE_MARKETPLACE_ADDRESS` | `FeeRightsFixedSale` on **Base mainnet** (`0x…`) |
| `VITE_DEFAULT_RECEIPT_COLLECTION` | `BankrFeeRightsReceipt` on Base (`0x…`) — optional default in the form |
| `VITE_RPC_URL` | HTTPS RPC for **Base mainnet** (Alchemy / QuickNode / etc.) for the **browser** |
| `VITE_CHAIN_ID` | Optional: `8453` (documentation only; the app is hardcoded to Base) |

Redeploy after changing any `VITE_*` value (they are baked in at **build** time).

### Remove from Railway (not for this static site)

Railway auto-imported things from `.env.example`. **Delete** from the **Bankr frontend** service:

- `PRIVATE_KEY` — **never** put deploy keys in Railway for this app. Use only on your laptop in `fee-rights-exchange/.env` for `forge script`.
- `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL` — not used by the Vite build unless you add custom code (the app uses `VITE_RPC_URL`).
- `ESCROW_INITIAL_OWNER`, `INITIAL_FEE_MANAGERS`, `TEST_FEE_TOKEN_*`, `DOPPLER_*`, `FEE_MANAGER`, `POOL_ID`, `SELLER` — Foundry / Doppler lab; **not** read by `bankr-app`.

You may keep **`ETHERSCAN_API_KEY`** in a **separate** place for local `forge verify`; it is **not** required for the Bankr web UI to run.

---

## Security note

If you pasted real API keys or RPC URLs into Railway or screenshots, **rotate** those keys in Alchemy / Etherscan and update Railway.
