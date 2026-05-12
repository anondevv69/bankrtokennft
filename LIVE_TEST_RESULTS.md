# Live Bankr Integration Test Results

Use this file to record real Base Sepolia custody tests against live Bankr fee-rights behavior. Do not record private keys, seed phrases, or sensitive wallet metadata.

## Deployment Under Test

- Network: Base Sepolia
- Escrow contract: `0xFb28D9C636514f8a9D129873750F9b886707d95F`
- Owner/deployer: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Deploy tx: `0xcdf9d0e9f8a69a2fc356ac3cf99df1ce8b6e4eff4aa9b6f75283c8fc67b79352`
- Escrow V2 contract: `0xDaA625F80c4beFB2b7c000519F0e503E4654F2BA`
- Escrow V2 deploy tx: `0x716ec1ef08b2e539377dd7a55208be9374c3b619080614da922645ec7eb8dc10`
- Escrow V2 allowlist tx: `0xdb6cf8e7b9d63b936728c4ee365eebe018b61999b2796e7f672f22aa7023ab42`

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

- Date: 2026-05-12
- Token: `0x543f82143bAfd178C335Ce06745A3fE9e61Bcbc3`
- Fee manager: `0x1718405E58c61425cDc0083262bC9f72198F5232`
- Pool ID: `0xb3638a06af7338dc08c5ff78fec0964a56c2e1cce185d96dc2657a4cd189fe7f`
- Seller wallet: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Recipient wallet: `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A`
- V2 `prepareDeposit(feeManager, poolId, token0, token1)` tx: `0xb1b23f391a1543c4ab17a1972fc47ed5bab7e3bbc5674cc675fbbd3c59ed52bb`
- Bankr `updateBeneficiary(poolId, escrowV2)` tx: `0x5218723d56b201969446471c9d5fb9fd85ac0983695825cf013e5d8f08cfd50c`
- V2 `finalizeDeposit` tx: `0x1618fd2fca2094b809add97efdd0af3173e5663510d062769fd8cd4fb477a4a4`
- V2 `releaseRights(poolId, recipient)` tx: `0xfb086bbd40b647a01596ef3450b742af4c3017f053a138b34775e678944d2009`
- Escrow share after release: `0`
- Recipient share after release: `900000000000000000`
- Escrow state cleared: yes, `isEscrowed = false`
- Fee recipient after release: `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A`
- Post-transfer verification result: recipient owned the fee rights before the reset transaction.
- Reset transaction back to seller for future tests: `0x80811fc0c5ed7bacac987ed4543085aac92589d915e82e51b4ff25a849ea0c2b`
- Final seller share after reset: `900000000000000000`
- Final escrow share after reset: `0`
- Gas notes: `prepareDeposit` `133991`, `updateBeneficiary` `73818`, `finalizeDeposit` `70900`, `releaseRights` `154900`, reset `76618`.
- Unexpected behavior: immediate post-transaction simulation/read paths can briefly lag on Base Sepolia. The first immediate `finalizeDeposit` simulation saw `EscrowDoesNotOwnRights`, but a later share read showed escrow owned `900000000000000000` shares and finalization succeeded.

## Flow 3: Claim Fees While Escrowed

Goal: prove escrow can claim real Bankr fees and internal accounting reflects claimed amounts.

- Date: 2026-05-12
- Token: `0x543f82143bAfd178C335Ce06745A3fE9e61Bcbc3`
- Fee manager: `0x1718405E58c61425cDc0083262bC9f72198F5232`
- Pool ID: `0xb3638a06af7338dc08c5ff78fec0964a56c2e1cce185d96dc2657a4cd189fe7f`
- Claimable before: cumulative reads were `0`; a tiny V4 swap created uncollected fees before claim.
- Escrow token/WETH balances before: WETH `0`, token `0`
- Swap activity tx: `0xcb471c5a97466a4b393c5420be39454c50e25b09409a21f6fa07f67536919001`
- `prepareDeposit` tx: `0x3a27bd8900ce6f12c34b312097f0756a2b7d1b562d3f848d844a8df187396810`
- Bankr `updateBeneficiary(poolId, escrow)` tx: `0x2be4b636f8d9403834b12aaf3a8d0ea954a55093b636199dcc96b82f95ace8f4`
- `finalizeDeposit` tx: `0x9d88d997a8e2dd7a09ecedbc33c535d4246a6ad7298b54c3f6bf9591aa12d966`
- `claimFees` tx: `0x73242b6cf14c457f02a68089a957c1ecc997c7f4177a0774bb7b56ee56f53684`
- Returned `fees0`: `149999999999`
- Returned `fees1`: `0`
- `accruedFees0`: `149999999999`
- `accruedFees1`: `0`
- Escrow token/WETH balances after: WETH `134999999999`, token `0`
- Return-rights tx: `0x1d07ef9469c61e2baa5a9fa594e1b099acadb52bdf664ce9d5a9b7d68a66eb75`
- Final seller share: `900000000000000000`
- Final escrow share: `0`
- Bankr/API claimable after: not checked through API; on-chain fee-right shares returned to seller.
- Timing or rounding observations: Base Sepolia receipt fields can briefly show zero block hashes; re-query after a few seconds gave the expected final shares.
- Unexpected behavior: `collectFees` returned total collected fees (`149999999999`) while escrow received only its beneficiary share (`134999999999`). This means the current `accruedFees0/accruedFees1` accounting can overstate actual assets received for Doppler multicurve pools.

## Flow 4: V2 Claim Accounting And Withdrawal

Goal: prove V2 uses actual token balance deltas for accounting and can withdraw claimed fees to the correct terminal recipient.

- Date: 2026-05-12
- Token: `0x543f82143bAfd178C335Ce06745A3fE9e61Bcbc3`
- Fee manager: `0x1718405E58c61425cDc0083262bC9f72198F5232`
- Pool ID: `0xb3638a06af7338dc08c5ff78fec0964a56c2e1cce185d96dc2657a4cd189fe7f`
- Escrow V2: `0xDaA625F80c4beFB2b7c000519F0e503E4654F2BA`
- Token0: `0x4200000000000000000000000000000000000006`
- Token1: `0x543f82143bAfd178C335Ce06745A3fE9e61Bcbc3`
- Swap activity tx: `0x712d2278ea578ca7d4d2341253dd59a4261e93320eba5dce87ad1c0dd59f7a4b`
- `prepareDeposit(feeManager, poolId, token0, token1)` tx: `0x63cc83c277c07699bce9474fd918242c1607acd6ef695a9565dca1c9c0f8fb92`
- Bankr `updateBeneficiary(poolId, escrowV2)` tx: `0xdb7566e55dbd6a0a74e5c3d5950c087c80625abf027386ad27e583d3d5369333`
- `finalizeDeposit` tx: `0x8a2640597f173aba3491810829df4bdeed05439841340d5f9ee20a25f519a03e`
- `claimFees` tx: `0xe05937b3b5c399d1f0b56ad43150839e503b13e4739571decb0c813b65047fec`
- `accruedFees0` after claim: `80999999999`
- `accruedFees1` after claim: `0`
- Escrow V2 WETH balance after claim: `80999999999`
- Escrow V2 token balance after claim: `0`
- `cancelRights` tx: `0xa3ca1773096ed3190179d82659cb08c20cb27ac024145259587d86c2307ac080`
- `withdrawClaimedFees(poolId, seller)` tx: `0xd65cf2b96b93ae353c4eaab4adc80a3139728eb5eba871888b287795ae4917df`
- Final seller share: `900000000000000000`
- Final escrow V2 share: `0`
- Final `isEscrowed`: `false`
- Final `accruedFees0`: `0`
- Final escrow V2 WETH balance: `0`
- Result: V2 accounting matched actual WETH received, and withdrawal cleared escrow-held fees.

## Flow 5: V2 Multiple Claims And Buyer Withdrawal

Goal: prove V2 actual balance-delta accounting accumulates across multiple claims and pays the buyer/recipient after release.

- Date: 2026-05-12
- Token: `0x543f82143bAfd178C335Ce06745A3fE9e61Bcbc3`
- Fee manager: `0x1718405E58c61425cDc0083262bC9f72198F5232`
- Pool ID: `0xb3638a06af7338dc08c5ff78fec0964a56c2e1cce185d96dc2657a4cd189fe7f`
- Escrow V2: `0xDaA625F80c4beFB2b7c000519F0e503E4654F2BA`
- Seller wallet: `0x7Cd24462901Ca865e66fBe47de2208006D8a0F4D`
- Buyer/recipient wallet: `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A`
- Pre-escrow swap tx: `0x01c4154b3efbc529fcdb4a7e4ec190c032501b8dcccc9e73a48c13f0e1625363`
- `claimFees` #1 tx: `0x8aa23f66cfe3369e0115f8abb0e48a44619ffc4d4cf7cb37fa4566a4f237f942`
- Escrow WETH before claim #1: `0`
- Escrow WETH after claim #1: `80999999999`
- `accruedFees0` after claim #1: `80999999999`
- Between-claims swap tx: `0x893c95cb1ec2f785f666c4cb471c717a8b3e2d5899e463d90fb9aa77a1cd52a9`
- `claimFees` #2 tx: `0x0921dd5732aad89fd9ffe38da986f3d28bc1380d336e6aa9deeb80c506b3b249`
- Escrow WETH before claim #2: `80999999999`
- Escrow WETH after claim #2: `161999999998`
- `accruedFees0` after claim #2: `161999999998`
- Actual claim #2 delta: `80999999999`
- `releaseRights(poolId, buyer)` tx: `0xfb086bbd40b647a01596ef3450b742af4c3017f053a138b34775e678944d2009`
- Buyer share after release: `900000000000000000`
- Escrow share after release: `0`
- `withdrawClaimedFees(poolId, buyer)` tx: `0xb1dad31e42e9d757c97a6c1ee180a1f190757a30dd194283b2fc499568c5b1aa`
- Buyer WETH before withdrawal: `0`
- Buyer WETH after withdrawal: `161999999998`
- Escrow WETH after withdrawal: `0`
- `accruedFees0` after withdrawal: `0`
- `accruedFees1` after withdrawal: `0`
- Reset buyer rights back to seller tx: `0x80811fc0c5ed7bacac987ed4543085aac92589d915e82e51b4ff25a849ea0c2b`
- Final seller share after reset: `900000000000000000`
- Final escrow share after reset: `0`
- Final buyer share after reset: `0`
- Gas used: claim #1 `324537`, between-claims swap `130719`, claim #2 `290337`, release `154900`, withdraw `67505`, reset `76618`.
- Result: actual escrow WETH balance equaled internal `accruedFees0` after both claims, withdrawal transferred the exact accrued amount to the buyer, and accounting cleared to zero.

## General Observations

- Ownership propagation timing: Base Sepolia RPC/simulation reads can lag for a few seconds after a successful transaction. Re-querying before the next dependent operation produced consistent state.
- Share accounting behavior:
- Fee accounting behavior: V2 balance-delta accounting matched actual WETH balances in both the cancel/seller withdrawal path and the release/buyer withdrawal path.
- Bankr API vs on-chain read differences:
- BaseScan event observations:
- Gas costs: `claimFees` observed at `290337` to `324537` gas, `releaseRights` at `154900`, and `withdrawClaimedFees` at `67505` in the latest V2 buyer path.
- Required contract changes before NFT phase: no new critical accounting issue observed in V2. Remaining work is product-layer authorization and NFT receipt design, not marketplace execution yet.
