# Bankr agent — use this repo to mirror or test the fee-rights MVP

Give a Bankr agent (or any assistant with **read access to this GitHub repo**) a **single instruction**:

```text
In this repository, open BANKR_AGENT_REPO_INDEX.md (repo root) and follow its sections in order to align copy, steps, and gating with the standalone bankr-app and on-chain contracts. Prefer INTEGRATION_NOTES.md and skills/bankr-fee-rights/SKILL.md for authoritative flows.
```

## 1. Install the in-Bankr skill (structured DMs / support)

Bankr: [Install a Skill from GitHub](https://docs.bankr.bot/skills/in-bankr/from-github/) — folder must expose **`SKILL.md`** at the folder root.

- **Skill folder (this repo):** `skills/bankr-fee-rights/`
- **Install line (adjust path if your GitHub layout nests this project):** see **`BANKR_APP.md`** → *Ask Bankr (agent skill)*.

After code changes, **re-run the install line** so Bankr refreshes the skill.

## 2. Read for product / mini-app parity (order)

| Priority | File | Why |
|----------|------|-----|
| 1 | `INTEGRATION_NOTES.md` | Custodial scanner, `prepare:transaction`, BFRR `tokenId` vs `poolId`, listing binary state, escalation |
| 2 | `BANKR_APP.md` | Apps SDK, `bankr.tx.prepare`, escrow vs marketplace contracts |
| 3 | `LAUNCH_CHECKLIST.md` | Go-live, beneficiary transfer checklist |
| 4 | `bankr-app/README.md` | Env vars (`VITE_*`), standalone dev, Railway |

## 3. Reference implementation (standalone site)

Use **`bankr-app/`** as the **UX truth** for “what the standalone marketplace does today” (not necessarily identical to a future Bankr iframe build, but good for parity testing):

| Area | Where to look |
|------|----------------|
| Home listings, search, refresh | `bankr-app/src/App.tsx` — listings section, `filteredHomeListings`, `useActiveListingsSearchEnrichment`, `ListingCard` |
| Listing card content (seller, pool tokens, symbols, names, receipt link) | Same file, `ListingCard` |
| Escrow wizard (prepare → transfer → finalize) | `bankr-app/src/EscrowWizard.tsx` |
| Styles | `bankr-app/src/index.css` — `.listing-card*`, `.listings-toolbar*` |

## 4. Parity checklist (Bankr site vs this MVP)

- [ ] **Base only** (chain id **8453**); wrong network banner / switch.
- [ ] **Sell:** three-step escrow + optional list; **never** invert prepare vs beneficiary order (see skill).
- [ ] **List:** `approve` / `setApprovalForAll` then `list`; explain custodial blocks + external wallet path.
- [ ] **Buy:** `buy(listingId)` with **exact** `msg.value == priceWei`.
- [ ] **Cancel sale** vs **Return to my wallet** (`redeemRights`) — different contracts and outcomes; do not conflate with burn.
- [ ] **Home:** listing grid + **search** (seller, addresses, symbols, pool id keywords) if product wants feature parity with `bankr-app`.
- [ ] **Pool id paste:** exactly `0x` + **64** hex chars; BaseScan decode hint as in app UI.

## 5. Contracts and env

Canonical **example** mainnet addresses live in **`skills/bankr-fee-rights/SKILL.md`**. Deployments can differ; for a given environment use **`bankr-app/.env`** (or operator docs), not hardcoded chat values.

## 6. What not to do

- Do not ask for seed phrases or private keys.
- Do not treat pasted raw JSON as the only execution path for Bankr wallet users; use **`prepare:transaction`** and documented Bankr APIs per **`INTEGRATION_NOTES.md`**.
