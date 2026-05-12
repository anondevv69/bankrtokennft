## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

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
