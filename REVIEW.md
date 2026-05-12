# Bankr Fee-Rights Escrow PoC Review

## Scope

Reviewed files:

- `src/BankrEscrowTest.sol`
- `src/interfaces/IBankrFees.sol`
- `test/BankrEscrowTest.t.sol`

This review focuses only on escrow custody mechanics before Base Sepolia deployment. It does not review or propose NFTs, marketplace logic, offers, frontend, mini app, buybacks, or tokenomics.

## Current Status

The first critical attribution race found in the original PoC has been fixed. The escrow now uses a secure pre-registration flow:

1. Seller calls `prepareDeposit(feeManager, poolId)` while still owning Bankr fee rights.
2. Escrow verifies the fee manager is allowlisted and the seller currently has shares.
3. Seller externally calls Bankr `updateBeneficiary(poolId, escrow)`.
4. Seller calls `finalizeDeposit(poolId)`.
5. Escrow verifies `getShares(poolId, address(this)) > 0`, records active custody, and clears pending state.

The test suite now covers the original misattribution attack, unauthorized finalize, fake/non-allowlisted fee managers, failed outbound transfer verification, and claimed-fee accounting.

## Fixed Findings

### F-01: Deposit attribution race

**Original severity:** Critical

Original issue: after a seller transferred Bankr rights to escrow, any address could call `depositRights` and register itself as `originalOwner`.

Fix:

- Removed the direct post-transfer `depositRights` flow.
- Added `prepareDeposit` before external Bankr transfer.
- Added `finalizeDeposit` restricted to the pre-registered seller.
- Added tests proving an attacker cannot finalize another seller's prepared deposit.

### F-02: Non-allowlisted fee managers

**Original severity:** Medium

Original issue: any contract implementing the Bankr interface could be used as a fee manager.

Fix:

- Added `allowedFeeManager`.
- Added owner-controlled `setFeeManagerAllowed`.
- `prepareDeposit` rejects unknown fee managers.
- Added tests for non-allowlisted/fake fee managers.

### F-03: Missing post-transfer verification

**Original severity:** Medium

Original issue: `releaseRights` and `cancelRights` trusted that `updateBeneficiary` succeeded if the external call did not revert.

Fix:

- Added `_verifyTransferred`.
- After release/cancel, escrow verifies:
  - escrow has zero shares, and
  - expected beneficiary has non-zero shares.
- Added tests proving state is preserved when a fee manager silently fails to transfer rights.

### F-04: Claimed-fee accounting visibility

**Original severity:** High

Original issue: `claimFees` collected fees but did not record the returned amounts.

Fix:

- Added `accruedFees0`.
- Added `accruedFees1`.
- `claimFees` increments both mappings.
- Added tests for fee accounting correctness.

Remaining risk: actual ERC20/native asset withdrawal and final entitlement rules are not implemented yet. See `H-01`.

## Critical Findings

No currently known critical findings remain in the custody PoC after the pre-registration fix.

## High Findings

### H-01: Claimed assets still need withdrawal and entitlement rules

**Severity:** High

`claimFees(bytes32 poolId)` now records returned fee amounts in `accruedFees0` and `accruedFees1`, but the contract still does not transfer claimed token balances to the party entitled to them.

This is intentionally incomplete for the custody PoC, but it is a deployment blocker for any real-value claim flow.

**Impact:** Real claimed assets could remain in the contract without a safe withdrawal or settlement path.

**Recommended fix before claiming real fees:**

Define who owns fees claimed during escrow:

- seller if the listing is canceled,
- buyer if the rights are released/sold,
- or split by explicit marketplace terms.

Then add token-aware withdrawal logic that transfers the actual claimed assets, not just internal accounting.

### H-02: Owner can still release escrowed rights to any address

**Severity:** High

`releaseRights(bytes32 poolId, address to)` is still `onlyOwner`. This is acceptable for a controlled Base Sepolia proof, but not for user-facing custody.

**Impact:** A compromised or malicious owner key can redirect escrowed fee rights.

**Recommended fix before production:**

Replace owner-controlled release with an authorization model tied to the next protocol layer:

- seller-approved buyer,
- temporary NFT owner,
- marketplace settlement contract,
- EIP-712 signed release,
- or multisig-controlled operator during limited testnet trials.

For Base Sepolia, use a fresh test wallet and treat the owner as a trusted test operator.

## Medium Findings

### M-01: State is still keyed only by `poolId`

**Severity:** Medium

State mappings are keyed by `bytes32 poolId`. Since fee managers are now allowlisted, fake manager collision risk is reduced, but a stronger model would key positions by both fee manager and pool ID:

```solidity
bytes32 positionId = keccak256(abi.encode(feeManager, poolId));
```

**Impact:** If multiple approved fee managers ever reuse the same `poolId`, state could collide.

**Recommended fix:**

Before supporting multiple Bankr/Clanker fee manager contracts, migrate escrow state to a `positionId`-keyed struct.

### M-02: Pending deposits can remain stuck

**Severity:** Medium

`prepareDeposit` creates pending state. If the seller never transfers rights or never finalizes, the pending deposit remains and blocks another prepare for that pool.

Also, if a seller transfers rights to escrow without calling `prepareDeposit` first, the escrow owns rights but has no active or pending state to release them.

**Impact:** Operational mistakes can block or orphan a test escrow flow.

**Recommended fix before broader testing:**

Add a pending-deposit cancellation path:

- seller can cancel before transferring rights,
- owner can clear expired pending deposits,
- optional timeout on pending state.

For mistakenly transferred unregistered rights, consider a tightly controlled rescue function for testnet only.

### M-03: `getClaimableFees` remains an estimate

**Severity:** Medium

`getClaimableFees` calculates claimable amounts from cumulative fee accounting only. Bankr docs note full live claimable fees also include uncollected pool fees surfaced by simulating `collectFees`.

**Impact:** UI or operational scripts may understate real claimable amounts.

**Recommended fix:**

Use Bankr public read APIs or collect simulation for user-facing claimable fee reads. Keep this function as a contract-level helper, not the canonical production fee quote.

### M-04: Fee manager allowlist requires correct operational setup

**Severity:** Medium

The escrow now rejects unknown fee managers. This is safer, but deployment will fail if the owner forgets to allowlist the correct Bankr fee manager/initializer.

**Impact:** Sellers cannot prepare deposits until the correct fee manager is allowed.

**Recommended fix:**

Create a deployment checklist that includes resolving and allowlisting the Bankr fee manager for the target test token.

## Low Findings

### L-01: Events could include operator fields

**Severity:** Low

Events include `poolId`, `feeManager`, seller, and recipient fields. They do not explicitly include `msg.sender`.

**Impact:** Indexers can infer operator from transaction data, but explicit event fields make analytics easier.

**Recommended fix:**

Add operator fields later if frontend/indexer requirements need them.

### L-02: More edge tests will be needed for Base Sepolia integration

**Severity:** Low

The local mock suite covers core state transitions. Before real testnet custody, add or manually execute tests for:

- real Bankr fee manager ABI compatibility,
- real `poolId` and initializer resolution,
- allowlist setup,
- seller mistake flows,
- gas usage on Base Sepolia,
- claim behavior with real token balances.

## Informational Findings

### I-01: Checks-effects-interactions is intentionally adapted

**Severity:** Informational

`releaseRights` and `cancelRights` call the external Bankr fee manager before clearing local state. This is correct here: if Bankr transfer fails or verification fails, local state must remain active.

Reentrancy risk is mitigated by `nonReentrant` on the mutating escrow functions.

### I-02: State clears correctly after successful release/cancel

**Severity:** Informational

After successful transfer verification, `_clearEscrow` deletes:

- `originalOwner[poolId]`
- `feeManagerForPool[poolId]`
- `isEscrowed[poolId]`

Claimed-fee accounting is intentionally not cleared because settlement/withdrawal rules are not implemented yet.

## Deployment Recommendation

Do not deploy to mainnet.

Before Base Sepolia testing:

1. Decide whether to add pending-deposit cancellation/rescue for safer test operations.
2. Prepare a deployment script.
3. Deploy to Base Sepolia with a fresh test owner wallet.
4. Allowlist only the real Bankr fee manager/initializer needed for the test token.
5. Run the real custody flow:
   - seller owns fee rights,
   - seller prepares deposit,
   - seller transfers Bankr rights to escrow,
   - seller finalizes escrow,
   - escrow releases or cancels,
   - Bankr reads confirm the final beneficiary.

Do not test real fee claiming until token withdrawal and entitlement logic is specified or until you are comfortable with claimed assets staying in the test escrow.
