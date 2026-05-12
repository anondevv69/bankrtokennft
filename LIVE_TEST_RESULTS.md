# Live Bankr Integration Test Results

Use this file to record real Base Sepolia custody tests against live Bankr fee-rights behavior. Do not record private keys, seed phrases, or sensitive wallet metadata.

## Deployment Under Test

- Network: Base Sepolia
- Escrow contract: `0xFb28D9C636514f8a9D129873750F9b886707d95F`
- Owner/deployer: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Deploy tx: `0xcdf9d0e9f8a69a2fc356ac3cf99df1ce8b6e4eff4aa9b6f75283c8fc67b79352`

## Flow 1: Deposit And Cancel

Goal: prove seller can escrow real Bankr fee rights and recover them through `cancelRights`.

- Date:
- Token:
- Fee manager:
- Pool ID:
- Seller wallet:
- Escrow share before prepare:
- Seller share before prepare:
- `prepareDeposit` tx:
- Bankr `updateBeneficiary(poolId, escrow)` tx:
- `finalizeDeposit` tx:
- Escrow share after finalize:
- Seller share after finalize:
- `originalOwner`:
- `pendingSeller` cleared:
- `cancelRights` tx:
- Escrow share after cancel:
- Seller share after cancel:
- Escrow state cleared:
- Gas notes:
- Unexpected behavior:

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
