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

Optional deployment variables:

- `ESCROW_INITIAL_OWNER`: owner/admin for the deployed escrow. Defaults to the deployer address if unset.
- `INITIAL_FEE_MANAGERS`: comma-separated Bankr fee manager addresses to allowlist during deployment.

### Verify Base Sepolia Deployment

See `VERIFICATION.md` for the deployed Base Sepolia address, constructor args, and `forge verify-contract` command.

### Integration Testing

Use `INTEGRATION_NOTES.md` to record live Bankr custody tests:

```text
prepareDeposit -> Bankr updateBeneficiary -> finalizeDeposit -> claim/cancel/release
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
