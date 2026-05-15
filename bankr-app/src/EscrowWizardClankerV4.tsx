import { useCallback, useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { encodeFunctionData, getAddress, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import { useChainId, useConfig, usePublicClient, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { MVP_CHAIN, MVP_CHAIN_ID } from "./chain";
import type { EscrowWizardProps } from "./escrowWizardTypes";
import { ensureBaseChain } from "./ensureBase";
import { clankerEscrowV4Abi } from "./lib/clankerEscrowV4Abi";
import { clankerLockerV4Abi } from "./lib/clankerLockerV4Abi";
import { launchRowLabel, rowLaunchedToken } from "./lib/escrowArgs";
import { rowClankerEffectiveLocker } from "./lib/clankerDetail";

export type EscrowWizardClankerV4Props = Omit<EscrowWizardProps, "escrowAddress"> & {
  clankerEscrowV4Address: Address;
};

// ── State machine ─────────────────────────────────────────────────────────────

type RewardInfo = { rewardIndex: bigint; token0: Address; token1: Address };

type NextAction =
  | { kind: "loading" }
  | { kind: "blocked"; reason: string }
  | { kind: "already_escrowed" }
  | { kind: "prepare" } & RewardInfo
  | { kind: "transfer_recipient" } & RewardInfo
  | { kind: "transfer_admin" } & RewardInfo
  | { kind: "finalize" } & RewardInfo;

// ── On-chain read helpers ─────────────────────────────────────────────────────

function v4EscrowKey(locker: Address, token: Address, rewardIndex: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [locker, token, rewardIndex],
    ),
  );
}

async function readV4State(
  client: PublicClient,
  escrow: Address,
  locker: Address,
  token: Address,
  user: Address,
  savedRewardIndex: bigint | null,
): Promise<NextAction> {
  const [rewardsRaw, allowed] = await Promise.all([
    client.readContract({
      address: locker,
      abi: clankerLockerV4Abi,
      functionName: "tokenRewards",
      args: [token],
    }),
    client.readContract({
      address: escrow,
      abi: clankerEscrowV4Abi,
      functionName: "allowedLocker",
      args: [locker],
    }),
  ]);

  if (!allowed) {
    return {
      kind: "blocked",
      reason:
        "This Clanker v4 locker is not allowlisted on your deployed ClankerEscrowV4. Ask the escrow owner to call setLockerAllowed.",
    };
  }

  const info = rewardsRaw as {
    token: Address;
    poolKey: { currency0: Address; currency1: Address };
    rewardAdmins: readonly Address[];
    rewardRecipients: readonly Address[];
  };

  const token0 = getAddress(info.poolKey.currency0);
  const token1 = getAddress(info.poolKey.currency1);
  const u = user.toLowerCase();
  const esc = escrow.toLowerCase();
  const zero = "0x0000000000000000000000000000000000000000";

  // --- Find effective reward index ---
  // Priority order:
  //   1. savedRewardIndex (from prior step in this session)
  //   2. index where user is current admin (pre-transfer, regardless of recipient)
  //   3. index where user is admin and escrow is recipient (after updateRewardRecipient)
  //   4. index where escrow is both admin and recipient (after updateRewardAdmin)
  //   5. index where escrow is admin but recipient ≠ escrow (stuck — admin transferred
  //      before recipient was redirected)

  const findIndex = (): bigint | null => {
    const admins = info.rewardAdmins;
    const recipients = info.rewardRecipients;

    if (savedRewardIndex !== null) return savedRewardIndex;

    // User is still admin (pre-transfer or mid-transfer, any recipient)
    for (let i = 0; i < admins.length; i++) {
      if (admins[i].toLowerCase() === u) return BigInt(i);
    }

    // Escrow is admin (fully transferred, or partially stuck)
    for (let i = 0; i < admins.length; i++) {
      if (admins[i].toLowerCase() === esc) return BigInt(i);
    }

    return null;
  };

  const rewardIndex = findIndex();

  if (rewardIndex === null) {
    return {
      kind: "blocked",
      reason:
        "Your wallet is not the reward admin for this token on the v4 locker. Connect the wallet that holds creator-admin rights.",
    };
  }

  const idx = Number(rewardIndex);
  const currentAdmin = (info.rewardAdmins[idx] ?? zero).toLowerCase();
  const currentRecipient = (info.rewardRecipients[idx] ?? zero).toLowerCase();

  // Check escrow contract state
  const key = v4EscrowKey(locker, token, rewardIndex);
  const [isEscrowed, pendingSeller] = await Promise.all([
    client.readContract({ address: escrow, abi: clankerEscrowV4Abi, functionName: "isEscrowed", args: [key] }),
    client.readContract({ address: escrow, abi: clankerEscrowV4Abi, functionName: "pendingSeller", args: [key] }),
  ]);

  if (isEscrowed) return { kind: "already_escrowed" };

  const ps = (pendingSeller as Address).toLowerCase();

  if (ps === zero) {
    // No pending deposit yet.
    if (currentAdmin !== u) {
      return {
        kind: "blocked",
        reason:
          "Your wallet is not the reward admin for this token. Connect the wallet that controls creator rewards.",
      };
    }
    return { kind: "prepare", rewardIndex, token0, token1 };
  }

  if (ps !== u) {
    return {
      kind: "blocked",
      reason: `Another wallet (${(pendingSeller as Address).slice(0, 10)}…) already has a pending deposit for this position.`,
    };
  }

  // User is the pending seller.
  if (currentAdmin === esc && currentRecipient === esc) {
    return { kind: "finalize", rewardIndex, token0, token1 };
  }
  if (currentAdmin === u && currentRecipient === esc) {
    return { kind: "transfer_admin", rewardIndex, token0, token1 };
  }
  // User is admin — redirect fee recipient to escrow regardless of who the current
  // recipient is (the original recipient might be a fee-split address, not the user).
  if (currentAdmin === u) {
    return { kind: "transfer_recipient", rewardIndex, token0, token1 };
  }
  // Escrow is admin but recipient was not redirected first (steps run out of order).
  // The escrow contract's cancelPendingDeposit will restore both roles.
  if (currentAdmin === esc && currentRecipient !== esc) {
    return {
      kind: "blocked",
      reason: `Admin was transferred before fee recipient was redirected. Click "Cancel deposit" to recover — the escrow will restore your admin rights automatically.`,
    };
  }

  return {
    kind: "blocked",
    reason: `Unexpected state — admin: ${currentAdmin.slice(0, 10)}… recipient: ${currentRecipient.slice(0, 10)}…. Refresh or cancel.`,
  };
}

async function waitAndRefresh(
  client: PublicClient,
  escrow: Address,
  locker: Address,
  token: Address,
  user: Address,
  rewardIndex: bigint,
  hash: Hex,
  exitKind: NextAction["kind"],
): Promise<NextAction> {
  await client.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });
  const deadline = Date.now() + 14_000;
  let last: NextAction = { kind: "loading" };
  while (Date.now() < deadline) {
    last = await readV4State(client, escrow, locker, token, user, rewardIndex);
    if (last.kind !== exitKind && last.kind !== "loading") return last;
    await new Promise((r) => setTimeout(r, 450));
  }
  return last;
}

// ── Stepper UI ────────────────────────────────────────────────────────────────

function V4Stepper({ step }: { step: 1 | 2 | 3 | 4 }) {
  const items: { n: 1 | 2 | 3 | 4; title: string; hint: string }[] = [
    { n: 1, title: "Prepare", hint: "Escrow records your v4 reward position" },
    { n: 2, title: "Redirect fees", hint: "Locker → set reward recipient to escrow" },
    { n: 3, title: "Transfer admin", hint: "Locker → set reward admin to escrow" },
    { n: 4, title: "Finalize", hint: "Escrow mints your TMPR receipt NFT" },
  ];
  return (
    <ol className="escrow-stepper" aria-label="Four steps on Base (Clanker v4)">
      {items.map((it) => {
        const done = step > it.n;
        const current = step === it.n;
        return (
          <li
            key={it.n}
            className={`escrow-stepper__item${done ? " escrow-stepper__item--done" : ""}${current ? " escrow-stepper__item--current" : ""}`}
          >
            <span className="escrow-stepper__dot" aria-hidden>
              {done ? "✓" : it.n}
            </span>
            <div className="escrow-stepper__text">
              <span className="escrow-stepper__title">{it.title}</span>
              <span className="escrow-stepper__hint">{it.hint}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function stepNumber(kind: NextAction["kind"]): 1 | 2 | 3 | 4 {
  if (kind === "prepare") return 1;
  if (kind === "transfer_recipient") return 2;
  if (kind === "transfer_admin") return 3;
  return 4;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EscrowWizardClankerV4({
  row,
  clankerEscrowV4Address,
  userAddress,
  onClose,
  onDone,
}: EscrowWizardClankerV4Props) {
  const config = useConfig();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();
  const { writeContractAsync, isPending: writePending } = useWriteContract();
  const { sendTransactionAsync, isPending: sendPending } = useSendTransaction();

  const [next, setNext] = useState<NextAction>({ kind: "loading" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Persist discovered reward index across refreshes within this wizard session.
  const [savedRewardIndex, setSavedRewardIndex] = useState<bigint | null>(null);

  const [locker, setLocker] = useState<Address | null>(null);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    setErr(null);
    setNext({ kind: "loading" });

    const launched = rowLaunchedToken(row);
    if (!launched) {
      setNext({ kind: "blocked", reason: "Missing launched token address on this row." });
      return;
    }

    const lockerA = rowClankerEffectiveLocker(row);
    if (!lockerA) {
      setNext({
        kind: "blocked",
        reason:
          "No v4 locker found for this token. Paste the locker address manually or configure VITE_CLANKER_V4_DEFAULT_LOCKER.",
      });
      return;
    }

    setLocker(lockerA);

    try {
      const state = await readV4State(publicClient, clankerEscrowV4Address, lockerA, launched, userAddress, savedRewardIndex);
      if ("rewardIndex" in state) setSavedRewardIndex(state.rewardIndex);
      setNext(state);
    } catch (e) {
      setNext({ kind: "blocked", reason: e instanceof Error ? e.message : "On-chain read failed — check RPC." });
    }
  }, [publicClient, row, userAddress, clankerEscrowV4Address, savedRewardIndex]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ensureBase = useCallback(() => ensureBaseChain(config, switchChainAsync), [config, switchChainAsync]);

  const launchedToken = rowLaunchedToken(row) as Address;

  const runPrepare = async () => {
    if (!locker || next.kind !== "prepare" || !publicClient) return;
    const { rewardIndex, token0, token1 } = next;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: clankerEscrowV4Address,
        abi: clankerEscrowV4Abi,
        functionName: "prepareDeposit",
        args: [locker, launchedToken, rewardIndex, token0, token1],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      const nextState = await waitAndRefresh(
        publicClient,
        clankerEscrowV4Address,
        locker,
        launchedToken,
        userAddress,
        rewardIndex,
        hash,
        "prepare",
      );
      setSavedRewardIndex(rewardIndex);
      setNext(nextState);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "prepareDeposit failed");
    } finally {
      setBusy(false);
    }
  };

  const runTransferRecipient = async () => {
    if (!locker || next.kind !== "transfer_recipient" || !publicClient) return;
    const { rewardIndex } = next;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const data = encodeFunctionData({
        abi: clankerLockerV4Abi,
        functionName: "updateRewardRecipient",
        args: [launchedToken, rewardIndex, clankerEscrowV4Address],
      }) as Hex;
      const hash = await sendTransactionAsync({
        to: locker,
        data,
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      const nextState = await waitAndRefresh(
        publicClient,
        clankerEscrowV4Address,
        locker,
        launchedToken,
        userAddress,
        rewardIndex,
        hash,
        "transfer_recipient",
      );
      setNext(nextState);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "updateRewardRecipient failed");
    } finally {
      setBusy(false);
    }
  };

  const runTransferAdmin = async () => {
    if (!locker || next.kind !== "transfer_admin" || !publicClient) return;
    const { rewardIndex } = next;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const data = encodeFunctionData({
        abi: clankerLockerV4Abi,
        functionName: "updateRewardAdmin",
        args: [launchedToken, rewardIndex, clankerEscrowV4Address],
      }) as Hex;
      const hash = await sendTransactionAsync({
        to: locker,
        data,
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      const nextState = await waitAndRefresh(
        publicClient,
        clankerEscrowV4Address,
        locker,
        launchedToken,
        userAddress,
        rewardIndex,
        hash,
        "transfer_admin",
      );
      setNext(nextState);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "updateRewardAdmin failed");
    } finally {
      setBusy(false);
    }
  };

  const runFinalize = async () => {
    if (!locker || next.kind !== "finalize" || !publicClient) return;
    const { rewardIndex } = next;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: clankerEscrowV4Address,
        abi: clankerEscrowV4Abi,
        functionName: "finalizeDeposit",
        args: [locker, launchedToken, rewardIndex],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      await publicClient.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "finalizeDeposit failed");
    } finally {
      setBusy(false);
    }
  };

  const runCancelPrepare = async () => {
    if (!locker || savedRewardIndex === null || !publicClient) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: clankerEscrowV4Address,
        abi: clankerEscrowV4Abi,
        functionName: "cancelPendingDeposit",
        args: [locker, launchedToken, savedRewardIndex],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      await publicClient.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });
      setSavedRewardIndex(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "cancelPendingDeposit failed");
    } finally {
      setBusy(false);
    }
  };

  const pending = writePending || sendPending || switchPending || busy;
  const wrongChain = chainId !== MVP_CHAIN_ID;
  const label = launchRowLabel(row);

  const rewardIndexLine =
    savedRewardIndex !== null ? (
      <p className="mono" style={{ fontSize: "0.72rem", wordBreak: "break-all", marginBottom: "0.5rem" }}>
        Reward index #{savedRewardIndex.toString()} · locker {locker?.slice(0, 10)}…
      </p>
    ) : null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-sheet escrow-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sheet__head">
          <h3>List for sale (Clanker v4)</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.65rem" }}>
          <strong>{label}</strong> — four Base transactions: prepare on escrow, redirect fees to escrow on the
          Clanker v4 locker, transfer admin to escrow, then finalize to mint your TMPR receipt NFT.
        </p>

        {wrongChain && (
          <p className="err" style={{ marginBottom: "0.5rem", fontSize: "0.85rem" }}>
            Switch your wallet to Base mainnet ({MVP_CHAIN_ID}).{" "}
            {switchChainAsync ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={pending}
                onClick={() =>
                  void ensureBase().catch((e) =>
                    setErr(e instanceof Error ? e.message : "Could not switch network"),
                  )
                }
              >
                {switchPending ? "Switching…" : "Switch to Base"}
              </button>
            ) : null}
          </p>
        )}

        {rewardIndexLine}

        {(writePending || sendPending) && (
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.5rem" }}>
            <span className="spinner" /> Approve in your wallet…
          </p>
        )}

        {busy && !writePending && !sendPending && !switchPending && next.kind !== "loading" && (
          <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.5rem" }}>
            <span className="spinner" /> Confirming on Base…
          </p>
        )}

        {next.kind === "loading" && (
          <p className="muted">
            <span className="spinner" /> Checking Clanker v4 locker…
          </p>
        )}

        {err && <p className="err">{err}</p>}

        {next.kind === "blocked" && next.reason && <p className="err">{next.reason}</p>}

        {next.kind === "already_escrowed" && (
          <p className="muted">Already escrowed on-chain — use your TMPR NFT to redeem.</p>
        )}

        {next.kind === "prepare" && (
          <div className="escrow-wizard__step">
            <V4Stepper step={1} />
            <p className="escrow-wizard__lead">
              Step <strong>1 of 4</strong> — prepare deposit on the Clanker v4 escrow contract.
            </p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => void runPrepare()}>
              {pending ? "…" : "Sign step 1 — prepare"}
            </button>
          </div>
        )}

        {next.kind === "transfer_recipient" && (
          <div className="escrow-wizard__step">
            <V4Stepper step={2} />
            <p className="escrow-wizard__done">Step 1 complete.</p>
            <p className="escrow-wizard__lead">
              Step <strong>2 of 4</strong> — redirect the fee recipient to the escrow contract. The current recipient
              will be restored when the NFT is redeemed or the deposit is cancelled.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending}
              onClick={() => void runTransferRecipient()}
            >
              {pending ? "…" : "Sign step 2 — redirect fees to escrow"}
            </button>
          </div>
        )}

        {next.kind === "transfer_admin" && (
          <div className="escrow-wizard__step">
            <V4Stepper step={3} />
            <p className="escrow-wizard__done">Steps 1–2 complete.</p>
            <p className="escrow-wizard__lead">
              Step <strong>3 of 4</strong> — call the Clanker v4 locker to transfer admin rights to the escrow.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={pending}
              onClick={() => void runTransferAdmin()}
            >
              {pending ? "…" : "Sign step 3 — transfer admin to escrow"}
            </button>
          </div>
        )}

        {next.kind === "finalize" && (
          <div className="escrow-wizard__step">
            <V4Stepper step={4} />
            <p className="escrow-wizard__done">Steps 1–3 complete.</p>
            <p className="escrow-wizard__lead">
              Step <strong>4 of 4</strong> — finalize mints your Token Marketplace (TMPR) receipt NFT.
            </p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => void runFinalize()}>
              {pending ? "…" : "Sign step 4 — mint NFT"}
            </button>
          </div>
        )}

        {(next.kind === "transfer_recipient" ||
          next.kind === "transfer_admin" ||
          next.kind === "finalize" ||
          savedRewardIndex !== null) && (
          <p style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={pending}
              onClick={() => void runCancelPrepare()}
            >
              Cancel deposit
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
