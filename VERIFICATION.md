# Base Sepolia Verification

> **Going to production on Base mainnet?** Follow **`LAUNCH_CHECKLIST.md`** first, then fill in the **Base mainnet (production)** section at the end of this file with real addresses and `forge verify-contract` commands (`--chain 8453`, [basescan.org](https://basescan.org)).

## Deployment

`BankrEscrowTest` was deployed to Base Sepolia:

- Contract: `0xFb28D9C636514f8a9D129873750F9b886707d95F`
- Transaction: `0xcdf9d0e9f8a69a2fc356ac3cf99df1ce8b6e4eff4aa9b6f75283c8fc67b79352`
- Chain ID: `84532`
- Initial owner: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`

`BankrEscrowV2` was deployed to Base Sepolia:

- Contract: `0xDaA625F80c4beFB2b7c000519F0e503E4654F2BA`
- Deployment transaction: `0x716ec1ef08b2e539377dd7a55208be9374c3b619080614da922645ec7eb8dc10`
- Initial fee-manager allowlist transaction: `0xdb6cf8e7b9d63b936728c4ee365eebe018b61999b2796e7f672f22aa7023ab42`
- Chain ID: `84532`
- Initial owner: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Initial fee manager: `0x1718405E58c61425cDc0083262bC9f72198F5232`

`TestFeeToken` was deployed to Base Sepolia as a laboratory ERC20:

- Contract: `0xCCbfd0FC0cB16D705F7E3846FDfA319DBf8F92F4`
- Transaction: `0x9beea8dedbe1b410e5eea62fdea38b54eed84d2c52e4e5ddfe4461439ef619f2`
- Chain ID: `84532`
- Initial supply: `1000000000000000000000000`
- Deployer/initial holder: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`

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

Use Foundry's Etherscan verifier with Base Sepolia chain ID. Do not pass the old BaseScan V1 `--verifier-url`; it is deprecated and can fail with a V2 migration error.

```bash
source .env
CONSTRUCTOR_ARGS=$(~/.foundry/bin/cast abi-encode "constructor(address)" 0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D)

~/.foundry/bin/forge verify-contract \
  0xFb28D9C636514f8a9D129873750F9b886707d95F \
  src/BankrEscrowTest.sol:BankrEscrowTest \
  --chain 84532 \
  --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $CONSTRUCTOR_ARGS \
  --watch
```

Successful verification URL:

```text
https://sepolia.basescan.org/address/0xfb28d9c636514f8a9d129873750f9b886707d95f
```

For V2, use:

```bash
source .env
CONSTRUCTOR_ARGS=$(~/.foundry/bin/cast abi-encode "constructor(address)" 0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D)

~/.foundry/bin/forge verify-contract \
  0xDaA625F80c4beFB2b7c000519F0e503E4654F2BA \
  src/BankrEscrowV2.sol:BankrEscrowV2 \
  --chain 84532 \
  --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $CONSTRUCTOR_ARGS \
  --watch
```

Successful V2 verification URL:

```text
https://sepolia.basescan.org/address/0xdaa625f80c4befb2b7c000519f0e503e4654f2ba
```

For the test token, use:

```bash
source .env
CONSTRUCTOR_ARGS=$(~/.foundry/bin/cast abi-encode "constructor(uint256)" 1000000000000000000000000)

~/.foundry/bin/forge verify-contract \
  0xCCbfd0FC0cB16D705F7E3846FDfA319DBf8F92F4 \
  src/TestFeeToken.sol:TestFeeToken \
  --chain 84532 \
  --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $CONSTRUCTOR_ARGS \
  --watch
```

Successful test token verification URL:

```text
https://sepolia.basescan.org/address/0xccbfd0fc0cb16d705f7e3846fdfa319dbf8f92f4
```

## FeeRightsFixedSale (fixed-price receipt marketplace)

Deploy first (see `README.md`), then fill in the address and deployment transaction below.

- Contract: `0x…` *(replace after `DeployFeeRightsFixedSale` broadcast)*
- Transaction: `0x…`
- Chain ID: `84532`

There is **no** user-defined constructor; do not pass `--constructor-args`.

### Forge verification command

```bash
source .env
FEE_RIGHTS_FIXED_SALE=0xYourDeployedAddress

~/.foundry/bin/forge verify-contract \
  $FEE_RIGHTS_FIXED_SALE \
  src/FeeRightsFixedSale.sol:FeeRightsFixedSale \
  --chain 84532 \
  --verifier etherscan \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --watch
```

After a successful run, the contract page should show verified source (replace with your checksummed address):

```text
https://sepolia.basescan.org/address/0xyourdeployedaddress
```

Confirm bytecode is present before verifying:

```bash
source .env
~/.foundry/bin/cast code $FEE_RIGHTS_FIXED_SALE --rpc-url $BASE_SEPOLIA_RPC_URL
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

---

## Base mainnet (production)

Fill these in **after** you broadcast on Base (`chain id 8453`). Explorer: [basescan.org](https://basescan.org). Use a paid RPC for `cast`/verification if the public endpoint is flaky.

### Deployed addresses (replace placeholders)

| Contract | Address | Deploy tx |
| --- | --- | --- |
| `BankrEscrowV3` | `0x…` | `0x…` |
| `BankrFeeRightsReceipt` | `0x…` (from `escrow.receipt()` or deploy logs) | *(same deploy as escrow if created in constructor)* |
| `FeeRightsFixedSale` | `0x…` | `0x…` |

### Verify `BankrEscrowV3` (constructor: `address initialOwner`)

```bash
source .env
ESCROW=0xYourEscrowV3
OWNER=0xYourInitialOwner
CONSTRUCTOR_ARGS=$(~/.foundry/bin/cast abi-encode "constructor(address)" "$OWNER")

~/.foundry/bin/forge verify-contract \
  "$ESCROW" \
  src/BankrEscrowV3.sol:BankrEscrowV3 \
  --chain 8453 \
  --verifier etherscan \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$CONSTRUCTOR_ARGS" \
  --watch
```

### Verify `BankrFeeRightsReceipt` (constructor: `address escrow_`)

```bash
source .env
RECEIPT=0xYourReceipt
ESCROW=0xYourEscrowV3
CONSTRUCTOR_ARGS=$(~/.foundry/bin/cast abi-encode "constructor(address)" "$ESCROW")

~/.foundry/bin/forge verify-contract \
  "$RECEIPT" \
  src/BankrFeeRightsReceipt.sol:BankrFeeRightsReceipt \
  --chain 8453 \
  --verifier etherscan \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$CONSTRUCTOR_ARGS" \
  --watch
```

### Verify `FeeRightsFixedSale` (no constructor args)

```bash
source .env
SALE=0xYourFeeRightsFixedSale

~/.foundry/bin/forge verify-contract \
  "$SALE" \
  src/FeeRightsFixedSale.sol:FeeRightsFixedSale \
  --chain 8453 \
  --verifier etherscan \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --watch
```

### Preflight (`cast code` on Base)

```bash
source .env
~/.foundry/bin/cast code 0xYourAddress --rpc-url "$BASE_MAINNET_RPC_URL"
```

