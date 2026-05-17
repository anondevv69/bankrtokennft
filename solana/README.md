# FeeRightsSplit — Solana Spike

> **Status:** Design spike only — not deployed. Requires security audit before mainnet use.

## What it does

`FeeRightsSplit` is a Solana program that replicates the Base `GroupBuyEscrow` + 0xSplits pattern for Pump.fun creator fees.

```
Coin creator → registers creator_pda as Pump.fun creator
→ anyone calls collect_and_distribute()
→ program CPIs into pump.fun collectCreatorFee
→ distributes SOL proportionally to all recipients on-chain
```

## Key design decisions

### PDA as Pump.fun creator
Pump.fun's `collectCreatorFee` instruction requires the original creator to sign.
`FeeRightsSplit` derives a PDA (`seeds = ["fee-rights-split", split.key()]`) that becomes
the token's creator authority. Because the program controls this PDA, it can sign the CPI
without any human signer.

**Implication:** the token must be created with `creator = creator_pda` from the start, or the
existing creator must call Pump.fun's authority-transfer mechanism (if available via PumpSwap CTO).

### Permissionless distribution
`collect_and_distribute` is callable by anyone. This enables bots / cron jobs to trigger
distributions without permission — identical to 0xSplits `distribute()` on EVM.

### Mutable recipients (admin-gated)
The admin (initial deployer) can update recipients, enabling partial-sale mechanics: the
original creator initializes with themselves at 100% BPS, then calls `update_recipients`
after selling a portion (reducing their share and adding buyers).

A **v2** of this program would mint a Solana NFT representing each recipient's share,
making the rights tradeable on Tensor/Magic Eden similar to TMPR on EVM.

## How to integrate with a Pump.fun group buy

1. Collect buyer contributions into a multisig (e.g. Squads v4) or this program itself.
2. Deploy a new Pump.fun token with `creator = creator_pda`.
3. After the token launches, call `initialize` with buyer shares proportional to their SOL contributions.
4. Any participant (or a keeper bot) calls `collect_and_distribute` to push fees.

## Differences from EVM

| | EVM (GroupBuyEscrow + 0xSplits) | Solana (FeeRightsSplit) |
|---|---|---|
| Fee claim trigger | `split.distribute(token)` | `collect_and_distribute()` |
| Creator authority | TMPR NFT → 0xSplits PushSplit | `creator_pda` PDA |
| Rights as NFT | TMPR ERC-721 | Future: Solana NFT per share |
| Audited protocol | 0xSplits V2 (audited) | This spike (not yet audited) |
| Tradeable shares | OpenSea / Uniswap | Tensor / Jupiter (v2) |

## Next steps for production

1. Replace the placeholder Pump.fun CPI discriminator with the real 8-byte value from the Pump.fun IDL.
2. Add a test suite using `anchor test` with a local Pump.fun program fork.
3. Implement `FeeRightsSplitNft` — mint a compressed NFT per recipient share for marketplace trading.
4. Security audit.
5. Deploy to Solana mainnet.

## Files

```
solana/
└── programs/
    └── fee_rights_split/
        └── src/
            └── lib.rs   ← this file
```

No `Cargo.toml` or `Anchor.toml` yet — add when progressing beyond spike.
