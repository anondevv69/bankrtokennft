# Base Sepolia Verification

## Deployment

`BankrEscrowTest` was deployed to Base Sepolia:

- Contract: `0xFb28D9C636514f8a9D129873750F9b886707d95F`
- Transaction: `0xcdf9d0e9f8a69a2fc356ac3cf99df1ce8b6e4eff4aa9b6f75283c8fc67b79352`
- Chain ID: `84532`
- Initial owner: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`

## Required Environment

Copy `.env.example` to `.env` and set:

```bash
BASE_SEPOLIA_RPC_URL=...
ETHERSCAN_API_KEY=...
```

Do not commit `.env`.

## Constructor Args

The constructor is:

```solidity
constructor(address initialOwner)
```

For this deployment:

```bash
CONSTRUCTOR_ARGS=$(~/.foundry/bin/cast abi-encode "constructor(address)" 0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D)
```

## Forge Verification Command

Use BaseScan's Base Sepolia API endpoint:

```bash
source .env
CONSTRUCTOR_ARGS=$(~/.foundry/bin/cast abi-encode "constructor(address)" 0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D)

~/.foundry/bin/forge verify-contract \
  0xFb28D9C636514f8a9D129873750F9b886707d95F \
  src/BankrEscrowTest.sol:BankrEscrowTest \
  --chain-id 84532 \
  --verifier etherscan \
  --verifier-url https://api-sepolia.basescan.org/api \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $CONSTRUCTOR_ARGS \
  --watch
```

## Dry Verification Prep

Before submitting verification, confirm the constructor args encode successfully:

```bash
~/.foundry/bin/cast abi-encode "constructor(address)" 0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D
```

You can also confirm the deployed bytecode exists:

```bash
source .env
~/.foundry/bin/cast code 0xFb28D9C636514f8a9D129873750F9b886707d95F --rpc-url $BASE_SEPOLIA_RPC_URL
```

If `cast code` returns `0x`, the contract is not visible at that address on the configured RPC/chain.
