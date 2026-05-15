## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Bankr fee-rights MVP (Option B)

**Option B** = permissive ERC721 receipt: transferable, composable with wallets and future OpenSea-style surfaces; Bankr provides the primary marketplace UX; **redemption and Bankr rights** stay in `BankrEscrowV3`, not in the sale contract.

**Layers:** escrow + receipt NFT (`BankrEscrowV3`, `BankrFeeRightsReceipt`) → optional **fixed listings and/or offer book** on `FeeRightsFixedSale` (generic `IERC721` only — it never touches fee managers or escrow internals).

**End-to-end flow:** `prepareDeposit` → Bankr beneficiary update → `finalizeDeposit` (mints receipt) → optional `list` / `buy` or standing offers (`placeOffer` / `acceptOffer`) → holder calls `redeemRights` / `withdrawClaimedFees` as documented for V3.

**Sale primitive scope:** fixed listings (`list` / `buy` / `cancel`) plus **unsolicited ETH offers** (`placeOffer` / `withdrawOffer` / `acceptOffer`) on any receipt id; on-chain reads `totalOfferWei` / `offerWei` and `OfferPlaced` events. Fixed price; ETH only; no auctions, royalties, protocol token, or buybacks in this contract.

Authoritative scope and contributor notes: `MVP_ROADMAP.md`. **Production go-live:** `LAUNCH_CHECKLIST.md`. **Railway troubleshooting:** `RAILWAY.md`.

### Bankr App (inside Bankr terminal)

The **canonical “connected to Bankr” UX** is a **Bankr App** (`index.html` + optional `scripts/`) using the [Apps SDK](https://docs.bankr.bot/apps/sdk), not the standalone Vite bundle alone. See **`BANKR_APP.md`** for manifest permissions, event indexing, `bankr.chain` / `bankr.tx.prepare` patterns, and how that relates to `bankr-app/`.

### Bankr web app (`bankr-app/`)

Vite + React + wagmi on **Base mainnet**: wallet connect, offers, list / cancel / buy — **standalone** (browser wallet only; no `bankr` iframe global). Set `VITE_MARKETPLACE_ADDRESS` (and optionally `VITE_DEFAULT_RECEIPT_COLLECTION`, `VITE_RPC_URL`) in `bankr-app/.env` — see `bankr-app/.env.example`. (Foundry workflows in this repo can still target Base Sepolia for lab deploys — see `VERIFICATION.md`.)

**Bankr agents / parity testing:** use **`BANKR_AGENT_REPO_INDEX.md`** (one pasteable instruction + checklist) and install the skill under **`skills/bankr-fee-rights/`** per **`BANKR_APP.md`**.

```shell
$ cd bankr-app && npm install && npm run dev
```

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy Bankr Escrow PoC

```shell
$ cp .env.example .env
$ # Fill BASE_SEPOLIA_RPC_URL and PRIVATE_KEY in .env, then:
$ source .env
$ forge script script/DeployBankrEscrowTest.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
$ forge script script/DeployBankrEscrowTest.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast
```

The first `forge script` command simulates the deployment. Only add `--broadcast` after the dry run succeeds.

Deploy the V2 escrow for live accounting tests:

```shell
$ source .env
$ INITIAL_FEE_MANAGERS=0x1718405E58c61425cDc0083262bC9f72198F5232 \
  ~/.foundry/bin/forge script script/DeployBankrEscrowV2.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Optional deployment variables:

- `ESCROW_INITIAL_OWNER`: owner/admin for the deployed escrow. Defaults to the deployer address if unset.
- `INITIAL_FEE_MANAGERS`: comma-separated Bankr fee manager addresses to allowlist during deployment.

### Verify Base Sepolia Deployment

See `VERIFICATION.md` for the deployed Base Sepolia address, constructor args, and `forge verify-contract` command.

### Deploy Test Fee Token

`TestFeeToken` is a plain ERC20 laboratory token for controlled Base Sepolia integration testing. It is not a future protocol token.

Current Base Sepolia deployment:

```text
TestFeeToken = 0xCCbfd0FC0cB16D705F7E3846FDfA319DBf8F92F4
```

```shell
$ source .env
$ ~/.foundry/bin/forge script script/DeployTestFeeToken.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Optional deployment variable:

```shell
TEST_FEE_TOKEN_INITIAL_SUPPLY=1000000000000000000000000
```

Default supply is `1,000,000 TFT` with 18 decimals. The token has no taxes, owner, transfer restrictions, or tokenomics.

### Integration Testing

Use `INTEGRATION_NOTES.md` to record live Bankr custody tests:

```text
prepareDeposit -> Bankr updateBeneficiary -> finalizeDeposit -> claim/cancel/release
```

For V2, `prepareDeposit` also requires token addresses:

```text
prepareDeposit(feeManager, poolId, token0, token1)
```

The live Doppler test pool uses:

```text
token0 = 0x4200000000000000000000000000000000000006
token1 = 0x543f82143bAfd178C335Ce06745A3fE9e61Bcbc3
```

### NFT Receipt Design

See `NFT_RECEIPT_DESIGN.md` for architecture notes. Implemented contracts:

- `src/BankrFeeRightsReceipt.sol` — ERC721 **`Token Marketplace` (`TMPR`)**, mint/burn only by escrow.
- `src/BankrEscrowV3.sol` — same fee flow as V2; `finalizeDeposit` mints the receipt; `redeemRights(tokenId)` gives Bankr rights to the NFT holder; seller `cancelRights` only while they still hold the NFT; `releaseRights` remains admin-only for emergencies.

See `MVP_ROADMAP.md` for how escrow + receipt + fixed sale fit together.

### Fixed-price receipt sale (`FeeRightsFixedSale`)

`src/FeeRightsFixedSale.sol` — ETH marketplace: fixed-price `list` / `buy` / `cancel`, plus **offers** (`placeOffer`, `withdrawOffer`, `acceptOffer`) on any `(collection, tokenId)` even when not listed. Read aggregate bid liquidity with `totalOfferWei(collection, tokenId)`; per-bidder balances with `offerWei`. New offers pause while the same token is in an active fixed listing (bidders can still withdraw). Same “never call Bankr fee rights” rule as in `MVP_ROADMAP.md`.

```shell
$ source .env
$ ~/.foundry/bin/forge script script/DeployFeeRightsFixedSale.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Deploy V3 (prints escrow + receipt addresses):

```shell
$ source .env
$ INITIAL_FEE_MANAGERS=0x1718405E58c61425cDc0083262bC9f72198F5232 \
  ~/.foundry/bin/forge script script/DeployBankrEscrowV3.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Typical flow:

```text
prepareDeposit → updateBeneficiary → finalizeDeposit (mints receipt) → optional transfer of receipt → redeemRights(tokenId) or cancelRights(poolId) while holding receipt → withdrawClaimedFees
```

Receipt id: `uint256(keccak256(abi.encode(feeManager, poolId)))` via `tokenIdFor` on escrow.

### Deploy Token Marketplace contracts (production redeploy)

**Architecture:** one shared `BankrFeeRightsReceipt` (TMPR) NFT collection + two escrows — `BankrEscrowV3` (Bankr tokens) and `ClankerEscrowV1` (Clanker tokens). Both escrows mint into the **same** TMPR collection so all fee-rights NFTs appear on **one** OpenSea page. Every NFT has a `"Launch factory": "Bankr"` or `"Clanker"` trait for filtering. Clanker tokens use a different deposit flow (seller transfers `creator.admin` instead of calling `updateBeneficiary`).

Use `script/DeployTokenMarketplace.s.sol` — it deploys all three contracts in one broadcast and wires everything up automatically.

**Known addresses (Base mainnet)**

| Contract | Address |
|---|---|
| Bankr fee manager | `0xbdf938149ac6a781f94faa0ed45e6a0e984c6544` |
| Clanker LpLockerv2 v3.1 | `0x33e2Eda238edcF470309b8c6D228986A1204c8f9` |

**Important**
- Addresses must be exact `0x` + 40 hex characters each (comma-separated, no spaces).
- **zsh:** paste commands without trailing `#` comments — zsh will error on bare `#`.

**1. Simulate (dry run)**

```shell
cd fee-rights-exchange
source .env

export BANKR_FEE_MANAGERS="0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"
export CLANKER_LOCKERS="0x33e2Eda238edcF470309b8c6D228986A1204c8f9"

forge script script/DeployTokenMarketplace.s.sol \
  --rpc-url "$BASE_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY"
```

**2. Broadcast + verify**

```shell
forge script script/DeployTokenMarketplace.s.sol \
  --rpc-url "$BASE_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY"
```

The script prints three addresses at the end — copy them directly into your `.env`:

```
VITE_DEFAULT_RECEIPT_COLLECTION=  <TMPR address>
VITE_BANKR_ESCROW_ADDRESS=        <BankrEscrowV3 address>
VITE_CLANKER_ESCROW_ADDRESS=      <ClankerEscrowV1 address>
```

Use a [Basescan API key](https://basescan.org/apis) as `ETHERSCAN_API_KEY` (Foundry passes it to the Blockscout-compatible verifier for Base).

**3. Rebuild the app (Vercel / CI)**

Set or update **before** `npm run build`:

| Variable | Set to |
|---|---|
| `VITE_DEFAULT_RECEIPT_COLLECTION` | TMPR receipt contract address (printed above) |
| `VITE_BANKR_ESCROW_ADDRESS` | `BankrEscrowV3` address (printed above) |
| `VITE_CLANKER_ESCROW_ADDRESS` | `ClankerEscrowV1` address (printed above) |
| `VITE_RECEIPT_COLLECTION_ALIASES` | Optional: old receipt contract(s) so legacy NFTs still appear |

`VITE_MARKETPLACE_ADDRESS` is unchanged unless you also redeploy `FeeRightsFixedSale`.

### Doppler SDK Test Launch

Use the Doppler SDK scripts to create a Base Sepolia test launch and discover whether the resulting fee manager is compatible with the Bankr fee-rights escrow ABI.

```shell
$ npm run doppler:simulate
$ npm run doppler:execute
```

`doppler:simulate` does not broadcast. `doppler:execute` broadcasts a Base Sepolia launch and prints the token address, pool ID, transaction hash, and candidate fee-manager share reads.
The helper defaults `DOPPLER_GAS_LIMIT` to `10500000`; override it only if the simulation estimate changes materially.

After a launch, set these values in your shell or `.env`:

```shell
FEE_MANAGER=0x...
POOL_ID=0x...
SELLER=0x...
```

Then probe compatibility:

```shell
$ npm run doppler:probe
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
