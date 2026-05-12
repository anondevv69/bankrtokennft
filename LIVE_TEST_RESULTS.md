# Live Bankr Integration Test Results

Use this file to record real Base Sepolia custody tests against live Bankr fee-rights behavior. Do not record private keys, seed phrases, or sensitive wallet metadata.

## Deployment Under Test

- Network: Base Sepolia
- Escrow contract: `0xFb28D9C636514f8a9D129873750F9b886707d95F`
- Owner/deployer: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Deploy tx: `0xcdf9d0e9f8a69a2fc356ac3cf99df1ce8b6e4eff4aa9b6f75283c8fc67b79352`

## Flow 1: Deposit And Cancel

Goal: prove seller can escrow real Bankr fee rights and recover them through `cancelRights`.

- Date: 2026-05-12
- Token: `0x543f82143bAfd178C335Ce06745A3fE9e61Bcbc3`
- Fee manager: `0x1718405E58c61425cDc0083262bC9f72198F5232`
- Pool ID: `0xb3638a06af7338dc08c5ff78fec0964a56c2e1cce185d96dc2657a4cd189fe7f`
- Seller wallet: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Escrow share before prepare: `0`
- Seller share before prepare: `900000000000000000`
- `prepareDeposit` tx: `0x3dd1225c2f8945b6fd60718ec53460fea5f4f578aefd0dbf4ffbddee44246a70`
- Bankr `updateBeneficiary(poolId, escrow)` tx: `0xac9d8e9e2533028d87e4f6f85aed2bb2ce61873924031888d9b28927564c8e40`
- `finalizeDeposit` tx: `0x385cc145347314043096d91ddd5559981185df0314583d1b02b7d74623a9e00c`
- Escrow share after finalize: `900000000000000000`
- Seller share after finalize: `0`
- `originalOwner`: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- `pendingSeller` cleared: yes
- `cancelRights` tx: `0x3251e377a5da5cbf2beecd55f97aac61db5f06f93d67661701467eab9d900e9e`
- Escrow share after cancel: `0`
- Seller share after cancel: `900000000000000000`
- Escrow state cleared: yes
- Gas notes: Doppler SDK launch tx `0x021845c569814bb3fe9c15396311f1f2dfe156be5e94794a9ac0c6f95da31dd7` used `8183720` gas. Initial 10-curve launch attempt `0xf6fbbbf14333d47840394263c9cbead4d4c6b522fd242bcb724ad521b2f86acb` failed near the default `13500000` gas limit, so the SDK helper now uses a simpler 2-curve launch and `DOPPLER_GAS_LIMIT=10500000`.
- Unexpected behavior: Base Sepolia RPC immediately returned some successful receipt fields with zero block hashes; re-querying after a short delay showed the expected final state.

## Flow 2: Deposit And Release

Goal: prove escrow can transfer real Bankr fee rights to a buyer/recipient.

- Date:
- Token:
- Fee manager:
- Pool ID:
- Seller wallet:
- Recipient wallet:
- `prepareDeposit` tx:
- Bankr `updateBeneficiary(poolId, escrow)` tx:
- `finalizeDeposit` tx:
- `releaseRights(poolId, recipient)` tx:
- Escrow share after release:
- Recipient share after release:
- Escrow state cleared:
- Post-transfer verification result:
- Gas notes:
- Unexpected behavior:

## Flow 3: Claim Fees While Escrowed

Goal: prove escrow can claim real Bankr fees and internal accounting reflects claimed amounts.

- Date:
- Token:
- Fee manager:
- Pool ID:
- Claimable before:
- Escrow token/WETH balances before:
- `claimFees` tx:
- Returned `fees0`:
- Returned `fees1`:
- `accruedFees0`:
- `accruedFees1`:
- Escrow token/WETH balances after:
- Bankr/API claimable after:
- Timing or rounding observations:
- Unexpected behavior:

## General Observations

- Ownership propagation timing:
- Share accounting behavior:
- Fee accounting behavior:
- Bankr API vs on-chain read differences:
- BaseScan event observations:
- Gas costs:
- Required contract changes before NFT phase:
