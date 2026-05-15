import { useCallback, useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { useChainId, useConfig, usePublicClient, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { MVP_CHAIN, MVP_CHAIN_ID } from "./chain";
import type { EscrowWizardProps } from "./escrowWizardTypes";
import { ensureBaseChain } from "./ensureBase";
import { clankerDefaultLockerFromEnv } from "./lib/deployAddresses";
import { clankerEscrowAbi } from "./lib/clankerEscrowAbi";
import { clankerLockerAbi } from "./lib/clankerLockerAbi";
import { launchRowLabel, rowLaunchedToken } from "./lib/escrowArgs";
import { resolveClankerLpTokenIdForPool } from "./lib/clankerLpResolve";
import { clankerEscrowKey } from "./lib/receiptRedeemEscrow";

export type EscrowWizardClankerProps = Omit<EscrowWizardProps, "escrowAddress"> & {
  clankerEscrowAddress: Address;
};

type NextAction =
  | { kind: "loading" }
  | { kind: "blocked"; reason: string }
  | { kind: "already_escrowed" }
  | { kind: "prepare" }
  | { kind: "transfer"; locker: Address }
  | { kind: "finalize" };

async function readClankerEscrowState(
  client: PublicClient,
  escrow: Address,
  locker: Address,
  lpTokenId: bigint,
): Promise<{
  allowed: boolean;
  isEscrowed: boolean;
  pendingSeller: Address;
  creatorAdmin: Address;
}> {
  const key = clankerEscrowKey(locker, lpTokenId);
  const rewardsUnknown = await client.readContract({
    address: locker,
    abi: clankerLockerAbi,
    functionName: "tokenRewards",
    args: [lpTokenId],
  });

  let creatorAdmin: Address;
  if (Array.isArray(rewardsUnknown)) {
    const tup = rewardsUnknown as readonly unknown[];
    const cr = tup[2] as { admin?: string };
    creatorAdmin = getAddress((cr.admin ?? "0x") as Address);
  } else {
    const o = rewardsUnknown as { creator: { admin: Address } };
    creatorAdmin = getAddress(o.creator.admin);
  }

  const [allowed, isEscrowed, pendingSeller] = await Promise.all([
    client.readContract({
      address: escrow,
      abi: clankerEscrowAbi,
      functionName: "allowedLocker",
      args: [locker],
    }),
    client.readContract({
      address: escrow,
      abi: clankerEscrowAbi,
      functionName: "isEscrowed",
      args: [key],
    }),
    client.readContract({
      address: escrow,
      abi: clankerEscrowAbi,
      functionName: "pendingSeller",
      args: [key],
    }),
  ]);

  return {
    allowed,
    isEscrowed,
    pendingSeller: getAddress(pendingSeller as Address),
    creatorAdmin,
  };
}

function deriveNextClanker(
  s: {
    allowed: boolean;
    isEscrowed: boolean;
    pendingSeller: Address;
    creatorAdmin: Address;
  },
  user: Address,
  escrow: Address,
  locker: Address,
): NextAction {
  if (s.isEscrowed) return { kind: "already_escrowed" };
  if (!s.allowed) {
    return {
      kind: "blocked",
      reason:
        "This Clanker locker is not allowlisted on your deployed Clanker escrow. Ask the escrow owner to call setLockerAllowed on-chain.",
    };
  }
  const u = user.toLowerCase();
  const ps = s.pendingSeller.toLowerCase();
  const zero = "0x0000000000000000000000000000000000000000";
  const adm = s.creatorAdmin.toLowerCase();
  const esc = escrow.toLowerCase();

  if (ps === zero) {
    if (adm !== u) {
      return {
        kind: "blocked",
        reason:
          "Your wallet is not the Clanker creator admin for this LP position. Connect the wallet that controls creator rewards on Clanker’s locker.",
      };
    }
    return { kind: "prepare" };
  }

  if (ps === u) {
    if (adm === esc) return { kind: "finalize" };
    if (adm === u) return { kind: "transfer", locker };
    return {
      kind: "blocked",
      reason: `Unexpected locker admin ${s.creatorAdmin.slice(0, 10)}… — refresh or cancel and retry.`,
    };
  }

  return {
    kind: "blocked",
    reason: `Another wallet (${s.pendingSeller.slice(0, 10)}…) already has a pending Clanker deposit for this LP NFT.`,
  };
}

async function syncAfterTxClanker(
  publicClient: PublicClient,
  escrow: Address,
  locker: Address,
  lpTokenId: bigint,
  user: Address,
  hash: Hex,
  stuckOn: "prepare" | "transfer",
): Promise<NextAction> {
  await publicClient.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });

  const deadline = Date.now() + 14_000;
  let last: NextAction = { kind: "loading" };
  while (Date.now() < deadline) {
    const s = await readClankerEscrowState(publicClient, escrow, locker, lpTokenId);
    last = deriveNextClanker(s, user, escrow, locker);
    if (stuckOn === "prepare" && last.kind !== "prepare") return last;
    if (stuckOn === "transfer" && last.kind !== "transfer") return last;
    await new Promise((r) => setTimeout(r, 450));
  }
  return last;
}

function ClankerEscrowStepper({ step }: { step: 1 | 2 | 3 }) {
  const items: { n: 1 | 2 | 3; title: string; hint: string }[] = [
    { n: 1, title: "Prepare", hint: "Escrow records your Clanker LP position" },
    { n: 2, title: "Transfer admin", hint: "Locker → set creator admin to escrow" },
    { n: 3, title: "Finalize", hint: "Escrow mints your TMPR receipt NFT" },
  ];
  return (
    <ol className="escrow-stepper" aria-label="Three steps on Base (Clanker)">
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

export function EscrowWizardClanker({
  row,
  clankerEscrowAddress,
  userAddress,
  onClose,
  onDone,
}: EscrowWizardClankerProps) {
  const config = useConfig();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();
  const { writeContractAsync, isPending: writePending } = useWriteContract();
  const { sendTransactionAsync, isPending: sendPending } = useSendTransaction();

  const [next, setNext] = useState<NextAction>({ kind: "loading" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [locker, setLocker] = useState<Address | null>(null);
  const [poolAddr, setPoolAddr] = useState<Address | null>(null);
  const [lpTokenId, setLpTokenId] = useState<bigint | null>(null);
  const [token0, setToken0] = useState<Address | null>(null);
  const [token1, setToken1] = useState<Address | null>(null);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    setErr(null);
    setNext({ kind: "loading" });

    const lockerRaw = row.__clankerLocker;
    const poolRaw = row.__clankerPool;
    const launched = rowLaunchedToken(row);

    if (typeof poolRaw !== "string" || !launched) {
      setNext({
        kind: "blocked",
        reason:
          "Missing Clanker pool — paste the Uniswap V3 pool contract on the profile row, or enable CLANKER_API_KEY on the server and refresh.",
      });
      return;
    }

    let poolA: Address;
    try {
      poolA = getAddress(poolRaw);
    } catch {
      setNext({ kind: "blocked", reason: "Invalid pool address in launch data." });
      return;
    }

    let lockerA: Address | null = null;
    if (typeof lockerRaw === "string") {
      try {
        lockerA = getAddress(lockerRaw);
      } catch {
        lockerA = null;
      }
    }
    if (!lockerA) {
      lockerA = clankerDefaultLockerFromEnv();
    }
    if (!lockerA) {
      setNext({
        kind: "blocked",
        reason:
          "No locker on this row — paste an optional locker override, or set VITE_CLANKER_DEFAULT_LOCKER / CLANKER_API_KEY.",
      });
      return;
    }

    setLocker(lockerA);
    setPoolAddr(poolA);

    try {
      const resolved = await resolveClankerLpTokenIdForPool(publicClient, {
        locker: lockerA,
        poolAddress: poolA,
        launchedToken: launched,
        user: userAddress,
      });
      if (!resolved) {
        setNext({
          kind: "blocked",
          reason:
            "Could not match an LP position NFT for this pool to your wallet via Clanker’s locker. If you sold or moved creator rights, they must be under your connected address.",
        });
        return;
      }
      setLpTokenId(resolved.lpTokenId);
      setToken0(resolved.token0);
      setToken1(resolved.token1);

      const s = await readClankerEscrowState(
        publicClient,
        clankerEscrowAddress,
        lockerA,
        resolved.lpTokenId,
      );
      setNext(deriveNextClanker(s, userAddress, clankerEscrowAddress, lockerA));
    } catch (e) {
      setNext({
        kind: "blocked",
        reason: e instanceof Error ? e.message : "On-chain read failed — check RPC.",
      });
    }
  }, [publicClient, row, userAddress, clankerEscrowAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ensureBase = useCallback(() => ensureBaseChain(config, switchChainAsync), [config, switchChainAsync]);

  const runPrepare = async () => {
    if (!locker || lpTokenId === null || !token0 || !token1 || !publicClient) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: clankerEscrowAddress,
        abi: clankerEscrowAbi,
        functionName: "prepareDeposit",
        args: [locker, lpTokenId, token0, token1],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      const nextState = await syncAfterTxClanker(
        publicClient,
        clankerEscrowAddress,
        locker,
        lpTokenId,
        userAddress,
        hash,
        "prepare",
      );
      setNext(nextState);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "prepareDeposit failed");
    } finally {
      setBusy(false);
    }
  };

  const runTransfer = async () => {
    if (!locker || lpTokenId === null || !publicClient) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const data = encodeFunctionData({
        abi: clankerLockerAbi,
        functionName: "updateCreatorRewardAdmin",
        args: [lpTokenId, clankerEscrowAddress],
      }) as Hex;
      const hash = await sendTransactionAsync({
        to: locker,
        data,
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      const nextState = await syncAfterTxClanker(
        publicClient,
        clankerEscrowAddress,
        locker,
        lpTokenId,
        userAddress,
        hash,
        "transfer",
      );
      setNext(nextState);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transfer tx failed");
    } finally {
      setBusy(false);
    }
  };

  const runFinalize = async () => {
    if (!locker || lpTokenId === null || !publicClient) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: clankerEscrowAddress,
        abi: clankerEscrowAbi,
        functionName: "finalizeDeposit",
        args: [locker, lpTokenId],
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
    if (!locker || lpTokenId === null || !publicClient) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: clankerEscrowAddress,
        abi: clankerEscrowAbi,
        functionName: "cancelPendingDeposit",
        args: [locker, lpTokenId],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      await publicClient.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });
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

  const lpLine =
    lpTokenId !== null ? (
      <p className="mono" style={{ fontSize: "0.72rem", wordBreak: "break-all", marginBottom: "0.5rem" }}>
        LP NFT #{lpTokenId.toString()}
      </p>
    ) : null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-sheet escrow-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sheet__head">
          <h3>List for sale (Clanker)</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.65rem" }}>
          <strong>{label}</strong> — three Base transactions: prepare on escrow, transfer creator-admin on Clanker’s locker,
          then finalize on escrow.
        </p>

        {wrongChain && (
          <p className="err" style={{ marginBottom: "0.5rem", fontSize: "0.85rem" }}>
            Switch your wallet to Base mainnet ({MVP_CHAIN_ID}).
            {" "}
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

        {lpLine}

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
            <span className="spinner" /> Checking Clanker locker…
          </p>
        )}

        {err && <p className="err">{err}</p>}

        {next.kind === "blocked" && next.reason && <p className="err">{next.reason}</p>}

        {next.kind === "already_escrowed" && (
          <p className="muted">Already escrowed on-chain — use your TMPR NFT below.</p>
        )}

        {next.kind === "prepare" && (
          <div className="escrow-wizard__step">
            <ClankerEscrowStepper step={1} />
            <p className="escrow-wizard__lead">
              Step <strong>1 of 3</strong> — prepare deposit on the Clanker escrow contract.
            </p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => void runPrepare()}>
              {pending ? "…" : "Sign step 1 — prepare"}
            </button>
          </div>
        )}

        {next.kind === "transfer" && (
          <div className="escrow-wizard__step">
            <ClankerEscrowStepper step={2} />
            <p className="escrow-wizard__done">Step 1 complete.</p>
            <p className="escrow-wizard__lead">
              Step <strong>2 of 3</strong> — call Clanker’s locker (<span className="mono">{locker?.slice(0, 10)}…</span>)
              to set creator admin to the escrow.
            </p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => void runTransfer()}>
              {pending ? "…" : "Sign step 2 — transfer admin to escrow"}
            </button>
          </div>
        )}

        {next.kind === "finalize" && (
          <div className="escrow-wizard__step">
            <ClankerEscrowStepper step={3} />
            <p className="escrow-wizard__done">Step 2 complete.</p>
            <p className="escrow-wizard__lead">
              Step <strong>3 of 3</strong> — finalize mints your Token Marketplace (TMPR) receipt NFT.
            </p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => void runFinalize()}>
              {pending ? "…" : "Sign step 3 — mint NFT"}
            </button>
          </div>
        )}

        {(next.kind === "prepare" || next.kind === "transfer") && (
          <p style={{ marginTop: "0.75rem" }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => void runCancelPrepare()}>
              Cancel
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
