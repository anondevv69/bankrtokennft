# Launch checklist — Base mainnet (Bankr MVP)

Use this **before** you point strangers at the app or post publicly. Prioritize **correct state transitions** over UI polish.

## 0. Mindset

You are shipping the **first usable version**, not the final protocol. Tonight: **small test pools**, **trusted testers**, **manually curated** listings if you need to — not an infinite open firehose on day one.

---

## 1. Deploy contracts on **Base mainnet** (chain `8453`)

Deploy from your machine (or locked-down CI). **Never** put `PRIVATE_KEY` in Railway or any `VITE_*` env.

| Contract | How |
| --- | --- |
| **BankrEscrowV3** + **BankrFeeRightsReceipt** | One script: receipt is created inside the escrow constructor. `DeployBankrEscrowV3` logs **both** addresses. |
| **FeeRightsFixedSale** | Separate script: `DeployFeeRightsFixedSale`. |

**RPC:** use a **paid** Base mainnet endpoint (Alchemy, QuickNode, Infura, Tenderly, etc.). Do **not** rely on the public default for production deploys or high-traffic reads.

**Examples** (set your own RPC env name; Foundry needs `--rpc-url`):

```bash
cd fee-rights-exchange
source .env   # PRIVATE_KEY, BASE_MAINNET_RPC_URL, ETHERSCAN_API_KEY, etc.

# Dry run (no broadcast)
forge script script/DeployBankrEscrowV3.s.sol --rpc-url "$BASE_MAINNET_RPC_URL"

forge script script/DeployBankrEscrowV3.s.sol \
  --rpc-url "$BASE_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast

# Then marketplace (separate tx / deployment)
forge script script/DeployFeeRightsFixedSale.s.sol \
  --rpc-url "$BASE_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

Record: escrow address, **receipt** address (`escrow.receipt()`), marketplace address, deployment tx hashes.

---

## 2. Verify **every** production contract on **BaseScan**

Trust: users should see verified source on [basescan.org](https://basescan.org) (mainnet), not unverified bytecode.

- **BankrEscrowV3** — `constructor(address initialOwner)` (same pattern as V2 in repo docs).
- **BankrFeeRightsReceipt** — `constructor(address escrow_)` — `escrow_` must be the **deployed escrow** address.
- **FeeRightsFixedSale** — no constructor args.

Use `forge verify-contract` with **`--chain 8453`** and your `ETHERSCAN_API_KEY` (same key flow as Sepolia; chain id differs). Fill in real addresses in **`VERIFICATION.md`** under **Base mainnet (production)** once deployed.

---

## 3. Configure **Railway** (frontend only)

1. **Deploy from GitHub** → repo → service **root directory:** `bankr-app`.
2. **Variables** (set **before** build so Vite inlines them):

| Variable | Notes |
| --- | --- |
| `VITE_MARKETPLACE_ADDRESS` | Deployed `FeeRightsFixedSale` on Base. |
| `VITE_DEFAULT_RECEIPT_COLLECTION` | `BankrFeeRightsReceipt` on Base. |
| `VITE_RPC_URL` | **Paid** Base HTTPS RPC for the browser (public RPC = rate limits / flaky UX). |
| `VITE_CHAIN_ID` | Optional documentation parity; app is hardcoded to **8453**. |

3. Build = `npm run build`, start = `npm start` (see `bankr-app/nixpacks.toml` / README).

**Do not** store private keys, deployer secrets, or escrow owner keys in Railway. Only wallet-based signing in the browser.

---

## 4. Deploy frontend on Railway

After green deploy, open the live URL with a wallet on **Base** (not Base Sepolia).

---

## 5. **Mandatory** end-to-end test (you, before any public post)

Run **one full live flow** yourself (two wallets):

| Step | Who |
| --- | --- |
| Escrow rights (prepare / Bankr beneficiary / finalize) | **Wallet A** |
| Receipt NFT minted to seller | **Wallet A** |
| List receipt on marketplace (approve + list) | **Wallet A** |
| Buy listing | **Wallet B** |
| Redeem rights (buyer) | **Wallet B** |
| Confirm beneficiary / fee recipient / accounting | On-chain reads |

**Verify explicitly:**

- Receipt **burned** after redeem (where the design says burn).
- Fee recipient / Bankr beneficiary updated as expected.
- Ownership / rights line up with your mental model.
- Funds / claims settled as expected.

**Only after** this passes: tweet, Discord blast, open floodgates.

### Bankr Marketplace seller step — fee beneficiary → escrow (preferred)

The on-chain escrow flow still needs **`prepareDeposit`** then **`finalizeDeposit`** after the **fee manager** shows the escrow holding shares. The **beneficiary change** itself should **not** rely on “open Doppler and paste” when the user is in Bankr.

Update the **Bankr Marketplace app** (seller wizard / `bankr-marketplace-v1`, not `fee-rights-exchange/bankr-app/` alone) to:

1. **Copy:** Primary CTA **“Transfer fees to escrow”** (secondary: “Open Doppler” only as fallback). Short warning: transfer is **forward-only**; [claim accrued fees first](https://docs.bankr.bot/token-launching/transferring-fees) if the user cares about fees pending at the old beneficiary.
2. **Bankr-managed beneficiary wallet:** call **`POST https://api.bankr.bot/user/doppler/execute-transfer-beneficiary`** with the user’s **Privy JWT**, `newBeneficiary` = **canonical escrow** from your deploy, and the correct **`tokenAddress`** (and any other required fields per current API docs). Gas is sponsored (within Bankr limits).
3. **External beneficiary wallet:** call **`POST https://api.bankr.bot/public/doppler/build-transfer-beneficiary`** with `tokenAddress`, `currentBeneficiary`, `newBeneficiary` = escrow → pass returned `to` / `data` / `chainId` into **`confirmTransaction`** (or user’s wallet). User pays gas.
4. **Resolve metadata** as needed: e.g. `GET /public/doppler/token-fees/:tokenAddress` for pool / initializer per [Bankr docs](https://docs.bankr.bot/token-launching/transferring-fees).
5. **Gate the wizard:** only advance after **successful** beneficiary transfer (API success or mined tx), then **`finalizeDeposit`** when on-chain reads show escrow shares.
6. **“Sell + list” orchestration:** If the unified flow includes **`list`**, require a **positive** listing price in ETH before start (`FeeRightsFixedSale` reverts **`ZeroPrice`** for `priceWei == 0`). Do **not** advertise “0 to skip” for that flow; use a separate **“wrap only”** (no list) path if users only want a BFRR without listing.

Reference: [Transferring fees to a new wallet](https://docs.bankr.bot/token-launching/transferring-fees).

---

## 6. What is *not* acceptable to ship broken

- Wrong ownership, stuck rights, failed redemption, or lost user funds.

Ugly UI, manual ops, and limited features **are** acceptable for the first cut.

---

## Related docs

- `VERIFICATION.md` — Sepolia lab history + **Base mainnet** verify templates.
- `RAILWAY.md` — variables to set / remove, fix for `index.js` crash, root vs `bankr-app` deploy.
- `bankr-app/README.md` — Railway, env vars, `npm run verify`.
