# Integration Notes

Track real Base Sepolia / Bankr behavior here. Do not record private keys, seed phrases, or sensitive wallet metadata.

## Deployment

- Network: Base Sepolia
- Escrow: `0xFb28D9C636514f8a9D129873750F9b886707d95F`
- Owner: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Deploy tx: `0xcdf9d0e9f8a69a2fc356ac3cf99df1ce8b6e4eff4aa9b6f75283c8fc67b79352`

## Test Case Template

### Test: prepare -> transfer -> finalize

- Date:
- Token:
- Fee manager:
- Pool ID:
- Seller wallet:
- Escrow wallet/contract:
- Starting seller share:
- Starting escrow share:
- Transaction hashes:
  - `prepareDeposit`:
  - Bankr `updateBeneficiary` to escrow:
  - `finalizeDeposit`:
- Final seller share:
- Final escrow share:
- Notes:

### Test: claim fees while escrowed

- Date:
- Token:
- Fee manager:
- Pool ID:
- Claimable before:
- `claimFees` tx:
- `accruedFees0` after:
- `accruedFees1` after:
- Actual received assets/balances:
- Notes:

### Test: cancel rights

- Date:
- Token:
- Fee manager:
- Pool ID:
- Seller wallet:
- Escrow share before:
- Seller share before:
- `cancelRights` tx:
- Escrow share after:
- Seller share after:
- Local escrow state cleared:
- Notes:

### Test: release rights

- Date:
- Token:
- Fee manager:
- Pool ID:
- Recipient wallet:
- Escrow share before:
- Recipient share before:
- `releaseRights` tx:
- Escrow share after:
- Recipient share after:
- Local escrow state cleared:
- Notes:

## Observations

- Ownership propagation:
- Share accounting behavior:
- Fee timing behavior:
- Unexpected reverts:
- Gas usage:
- Bankr API/on-chain read differences:
- Follow-up contract changes needed:
