import { useCallback, useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { getAddress, type Address, type Hex, isHex } from "viem";
import { useChainId, useConfig, usePublicClient, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { MVP_CHAIN, MVP_CHAIN_ID } from "./chain";
import { ensureBaseChain } from "./ensureBase";
import { bankrEscrowAbi } from "./lib/bankrEscrowAbi";
import { bankrFeesMinimalAbi } from "./lib/bankrFeesMinimalAbi";
import { inferToken0Token1, rowLaunchedToken, launchRowLabel, rowPoolIdHex } from "./lib/escrowArgs";

import { EscrowWizardClanker } from "./EscrowWizardClanker";
import { EscrowWizardClankerV4 } from "./EscrowWizardClankerV4";
import type { EscrowWizardProps } from "./escrowWizardTypes";
import { rowClankerListingReady, rowClankerLockerVersion } from "./lib/clankerDetail";
import {
  CANONICAL_BANKR_ESCROW,
  clankerEscrowAddressFromEnv,
  clankerEscrowV4AddressFromEnv,
  defaultReceiptCollectionFromEnv,
  isLegacyBankrEscrow,
} from "./lib/deployAddresses";

export type { EscrowWizardProps } from "./escrowWizardTypes";

function rowFeeManager(row: Record<string, unknown>): Address | null {
  const v = row.feeManager ?? row.fee_manager;
  if (typeof v !== "string" || !v.startsWith("0x")) return null;
  try {
    return getAddress(v.trim());
  } catch {
    return null;
  }
}

type NextAction =
  | { kind: "loading" }
  | { kind: "blocked"; reason: string }
  | { kind: "already_escrowed" }
  | { kind: "prepare" }
  | { kind: "transfer"; to: Address; data: Hex; chainId: number }
  | { kind: "finalize" };

async function readEscrowState(
  client: PublicClient,
  escrow: Address,
  feeManager: Address,
  poolId: Hex,
  user: Address,
): Promise<{
  allowed: boolean;
  isEscrowed: boolean;
  pendingSeller: Address;
  userShares: bigint;
  escrowShares: bigint;
}> {
  const [allowed, isEscrowed, pendingSeller, userShares, escrowShares] = await Promise.all([
    client.readContract({
      address: escrow,
      abi: bankrEscrowAbi,
      functionName: "allowedFeeManager",
      args: [feeManager],
    }),
    client.readContract({
      address: escrow,
      abi: bankrEscrowAbi,
      functionName: "isEscrowed",
      args: [poolId],
    }),
    client.readContract({
      address: escrow,
      abi: bankrEscrowAbi,
      functionName: "pendingSeller",
      args: [poolId],
    }),
    client.readContract({
      address: feeManager,
      abi: bankrFeesMinimalAbi,
      functionName: "getShares",
      args: [poolId, user],
    }),
    client.readContract({
      address: feeManager,
      abi: bankrFeesMinimalAbi,
      functionName: "getShares",
      args: [poolId, escrow],
    }),
  ]);
  return {
    allowed,
    isEscrowed,
    pendingSeller: getAddress(pendingSeller),
    userShares,
    escrowShares,
  };
}

function deriveNext(
  s: {
    allowed: boolean;
    isEscrowed: boolean;
    pendingSeller: Address;
    userShares: bigint;
    escrowShares: bigint;
  },
  user: Address,
  transfer: { to: Address; data: Hex; chainId: number } | null,
): NextAction {
  if (s.isEscrowed) return { kind: "already_escrowed" };
  if (!s.allowed) {
    return {
      kind: "blocked",
      reason:
        "This build’s escrow isn’t allowlisted for this pool’s fee manager. Set VITE_ESCROW_ADDRESS to your live escrow contract and rebuild, or ask the escrow owner to allowlist this fee manager.",
    };
  }
  const u = user.toLowerCase();
  const ps = s.pendingSeller.toLowerCase();
  if (ps !== "0x0000000000000000000000000000000000000000") {
    if (ps !== u) {
      return {
        kind: "blocked",
        reason: `Another address (${s.pendingSeller.slice(0, 10)}…) already has a pending prepare for this pool. Only that wallet can continue or cancel.`,
      };
    }
    if (s.escrowShares > 0n) return { kind: "finalize" };
    if (!transfer) return { kind: "blocked", reason: "Missing transfer transaction payload." };
    return { kind: "transfer", ...transfer };
  }
  if (s.userShares === 0n) {
    return {
      kind: "blocked",
      reason:
        "Your wallet has no fee-manager shares for this pool. You must be the current beneficiary on-chain (check claimable fees for your pool).",
    };
  }
  return { kind: "prepare" };
}

/** Wait for inclusion, then poll chain reads — RPC often lags right after `writeContract` resolves. */
async function syncAfterTx(
  publicClient: PublicClient,
  escrow: Address,
  feeManager: Address,
  poolId: Hex,
  user: Address,
  transfer: { to: Address; data: Hex; chainId: number },
  hash: Hex,
  stuckOn: "prepare" | "transfer",
): Promise<NextAction> {
  await publicClient.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });

  const deadline = Date.now() + 14_000;
  let last: NextAction = { kind: "loading" };
  while (Date.now() < deadline) {
    const s = await readEscrowState(publicClient, escrow, feeManager, poolId, user);
    last = deriveNext(s, user, transfer);
    if (stuckOn === "prepare" && last.kind !== "prepare") return last;
    if (stuckOn === "transfer" && last.kind !== "transfer") return last;
    await new Promise((r) => setTimeout(r, 450));
  }
  return last;
}

/** Three on-chain steps — cannot be one transaction (escrow + fee manager + escrow). */
function EscrowStepper({ step }: { step: 1 | 2 | 3 }) {
  const items: { n: 1 | 2 | 3; title: string; hint: string }[] = [
    { n: 1, title: "Prepare", hint: "Escrow contract records your pool" },
    { n: 2, title: "Transfer fees", hint: "Fee contract → beneficiary points at escrow" },
    { n: 3, title: "Finalize", hint: "Escrow mints your fee-rights NFT" },
  ];
  return (
    <ol className="escrow-stepper" aria-label="Three steps on Base">
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

function EscrowWizardBankr({ row, escrowAddress, userAddress, onClose, onDone }: EscrowWizardProps) {
  const config = useConfig();
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();
  const { writeContractAsync, isPending: writePending } = useWriteContract();
  const { sendTransactionAsync, isPending: sendPending } = useSendTransaction();

  const [next, setNext] = useState<NextAction>({ kind: "loading" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [poolId, setPoolId] = useState<Hex | null>(null);
  const [feeManager, setFeeManager] = useState<Address | null>(null);
  const [transferPayload, setTransferPayload] = useState<{ to: Address; data: Hex; chainId: number } | null>(null);
  const [token0, setToken0] = useState<Address | null>(null);
  const [token1, setToken1] = useState<Address | null>(null);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    setErr(null);
    setNext({ kind: "loading" });

    if (isLegacyBankrEscrow(escrowAddress)) {
      setNext({
        kind: "blocked",
        reason: `This listing would mint on legacy escrow ${escrowAddress} (BFRR collection), not Token Marketplace. Rebuild the site with VITE_BANKR_ESCROW_ADDRESS=${CANONICAL_BANKR_ESCROW} and redeploy Vercel.`,
      });
      return;
    }

    try {
      const escrowReceipt = await publicClient.readContract({
        address: escrowAddress,
        abi: bankrEscrowAbi,
        functionName: "receipt",
      });
      const expected = defaultReceiptCollectionFromEnv();
      if (getAddress(escrowReceipt as Address).toLowerCase() !== expected.toLowerCase()) {
        setNext({
          kind: "blocked",
          reason: `Bankr escrow receipt is ${escrowReceipt as string}, but this app expects ${expected} (Token Marketplace / OpenSea). Wrong VITE_BANKR_ESCROW_ADDRESS in the production build.`,
        });
        return;
      }
    } catch {
      setNext({ kind: "blocked", reason: "Could not read escrow.receipt() on Base — check RPC." });
      return;
    }

    const pid = rowPoolIdHex(row);
    const launched = rowLaunchedToken(row);
    if (!pid || !launched) {
      setNext({ kind: "blocked", reason: "This row is missing a valid poolId or tokenAddress from launch data." });
      return;
    }
    setPoolId(pid);
    const [t0, t1] = inferToken0Token1(launched);
    setToken0(t0);
    setToken1(t1);

    const fmFromRow = rowFeeManager(row);
    let fm: Address | undefined;
    let payload: { to: Address; data: Hex; chainId: number } | null = null;

    try {
      const res = await fetch("/api/bankr-build-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          tokenAddress: launched,
          currentBeneficiary: userAddress,
          newBeneficiary: escrowAddress,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        data?: { to?: string; data?: string; chainId?: number };
        body?: unknown;
      };
      const d = json.data;
      const bankrOk =
        Boolean(json.ok) &&
        d &&
        typeof d.to === "string" &&
        typeof d.data === "string" &&
        isHex(d.data);
      if (bankrOk && d) {
        fm = getAddress(d.to);
        payload = {
          to: fm,
          data: d.data as Hex,
          chainId: typeof d.chainId === "number" ? d.chainId : MVP_CHAIN_ID,
        };
      } else {
        let detail = json.error || `HTTP ${res.status}`;
        if (json.body && typeof json.body === "object" && "error" in json.body) {
          detail = String((json.body as { error?: string }).error);
        }
        const beneficiaryMismatch =
          typeof detail === "string" && /not a beneficiary|beneficiary/i.test(detail) && fmFromRow !== null;
        if (!beneficiaryMismatch) {
          setNext({ kind: "blocked", reason: `Could not build beneficiary transfer: ${detail}` });
          return;
        }
        fm = fmFromRow;
        payload = null;
      }
    } catch (e) {
      setNext({
        kind: "blocked",
        reason:
          e instanceof Error
            ? e.message
            : "build-transfer request failed (deploy /api/bankr-build-transfer on Vercel).",
      });
      return;
    }

    if (!fm) {
      setNext({
        kind: "blocked",
        reason:
          "Could not determine the fee manager contract. Add the optional “Fee manager” field from your Prepare deposit transaction (first address in the decoded input) and open listing setup again.",
      });
      return;
    }

    setFeeManager(fm);
    setTransferPayload(payload);

    try {
      const s = await readEscrowState(publicClient, escrowAddress, fm, pid, userAddress);
      let n = deriveNext(s, userAddress, payload);
      if (n.kind === "blocked" && !s.allowed) {
        n = {
          kind: "blocked",
          reason:
            `Escrow ${escrowAddress} has fee manager ${fm} disabled (read allowedFeeManager on BaseScan). Either set VITE_ESCROW_ADDRESS to an escrow that already allowlists this manager and rebuild, or ask the owner of this escrow to call setFeeManagerAllowed(${fm}, true).`,
        };
      }
      setNext(n);
    } catch (e) {
      setNext({
        kind: "blocked",
        reason: e instanceof Error ? e.message : "On-chain read failed — check RPC.",
      });
    }
  }, [publicClient, row, escrowAddress, userAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Use the wallet client's chain (what MetaMask will sign), not only wagmi's `useChainId`,
   * which can briefly disagree after connect or when the extension network differs from the app.
   */
  const ensureBase = useCallback(
    () => ensureBaseChain(config, switchChainAsync),
    [config, switchChainAsync],
  );

  const runPrepare = async () => {
    if (!feeManager || !poolId || !token0 || !token1 || !transferPayload || !publicClient) return;
    setBusy(true);
    setErr(null);
    const tp = transferPayload;
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: escrowAddress,
        abi: bankrEscrowAbi,
        functionName: "prepareDeposit",
        args: [feeManager, poolId, token0, token1],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      const nextState = await syncAfterTx(
        publicClient,
        escrowAddress,
        feeManager,
        poolId,
        userAddress,
        tp,
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
    if (!transferPayload || !publicClient) return;
    setBusy(true);
    setErr(null);
    const tp = transferPayload;
    try {
      await ensureBase();
      const hash = await sendTransactionAsync({
        to: tp.to,
        data: tp.data,
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      const nextState = await syncAfterTx(
        publicClient,
        escrowAddress,
        feeManager!,
        poolId!,
        userAddress,
        tp,
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
    if (!poolId || !publicClient) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: escrowAddress,
        abi: bankrEscrowAbi,
        functionName: "finalizeDeposit",
        args: [poolId],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      await publicClient.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });
      await refresh();
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "finalizeDeposit failed");
    } finally {
      setBusy(false);
    }
  };

  const runCancelPrepare = async () => {
    if (!poolId || !publicClient) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      const hash = await writeContractAsync({
        address: escrowAddress,
        abi: bankrEscrowAbi,
        functionName: "cancelPendingDeposit",
        args: [poolId],
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
  /** Prefer wagmi chain; UI hint only — `ensureBase` re-checks the signer before each tx. */
  const wrongChain = chainId !== MVP_CHAIN_ID;
  const label = launchRowLabel(row);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-sheet escrow-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sheet__head">
          <h3>List for sale</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.65rem" }}>
          <strong>{label}</strong> — escrow uses <strong>up to three separate Base transactions</strong>. Confirm each on-chain before the next step appears.
        </p>

        {wrongChain && (
          <p className="err" style={{ marginBottom: "0.5rem", fontSize: "0.85rem" }}>
            The app uses Base, but the chain your wallet will sign on is <strong>{chainId}</strong> (Base is <strong>{MVP_CHAIN_ID}</strong>). Open MetaMask (or your wallet) and switch the network to Base, or use the button below.
            {" "}
            {switchChainAsync ? (
              <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => void ensureBase().catch((e) => setErr(e instanceof Error ? e.message : "Could not switch network"))}>
                {switchPending ? "Switching…" : "Switch to Base"}
              </button>
            ) : (
              <span className="muted"> Switch Base in your wallet app if this site cannot request it.</span>
            )}
          </p>
        )}

        {poolId && (
          <p className="mono" style={{ fontSize: "0.72rem", wordBreak: "break-all", marginBottom: "0.5rem" }}>
            {poolId.slice(0, 14)}…{poolId.slice(-10)}
          </p>
        )}

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
            <span className="spinner" /> Checking…
          </p>
        )}

        {err && <p className="err">{err}</p>}

        {next.kind === "blocked" && next.reason && (
          <>
            <p className="err">{next.reason}</p>
            {/beneficiary/i.test(next.reason) && (
              <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.55rem", lineHeight: 1.45 }}>
                The transfer step is built only if <span className="mono">{userAddress}</span> is the wallet that{" "}
                <strong>currently</strong> receives trading fees for the token you entered. Connect the fee-recipient wallet on Base, or re-check the <strong>launched token address</strong> and <strong>pool id</strong> match your pool. If another address still receives fees on-chain, complete fee setup for that address first.
              </p>
            )}
          </>
        )}

        {next.kind === "already_escrowed" && (
          <p className="muted">Already done on-chain — use your NFT below.</p>
        )}

        {next.kind === "prepare" && (
          <div className="escrow-wizard__step">
            <EscrowStepper step={1} />
            <p className="escrow-wizard__lead">Step <strong>1 of 3</strong> — sign in your wallet. When Base confirms, step 2 unlocks.</p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => void runPrepare()}>
              {pending ? "…" : "Sign step 1 — prepare"}
            </button>
          </div>
        )}

        {next.kind === "transfer" && (
          <div className="escrow-wizard__step">
            <EscrowStepper step={2} />
            <p className="escrow-wizard__done">Step 1 complete.</p>
            <p className="escrow-wizard__lead">Step <strong>2 of 3</strong> — another wallet signature on the fee contract. After Base confirms, step 3 is the last one.</p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => void runTransfer()}>
              {pending ? "…" : "Sign step 2 — transfer fee rights"}
            </button>
          </div>
        )}

        {next.kind === "finalize" && (
          <div className="escrow-wizard__step">
            <EscrowStepper step={3} />
            <p className="escrow-wizard__done">Step 2 complete.</p>
            <p className="escrow-wizard__lead">Step <strong>3 of 3</strong> — final signature mints your NFT so you can list it here.</p>
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

export function EscrowWizard(props: EscrowWizardProps) {
  if (rowClankerListingReady(props.row)) {
    const lockerVersion = rowClankerLockerVersion(props.row);

    // ── Clanker v4 ──────────────────────────────────────────────────────────
    if (lockerVersion === "v4") {
      const ce4 = clankerEscrowV4AddressFromEnv();
      if (!ce4) {
        return (
          <div className="settings-overlay" onClick={props.onClose}>
            <div className="settings-sheet escrow-wizard" onClick={(e) => e.stopPropagation()}>
              <div className="settings-sheet__head">
                <h3>List for sale (Clanker v4)</h3>
                <button type="button" className="btn btn-ghost btn-sm" onClick={props.onClose}>
                  ✕
                </button>
              </div>
              <p className="err">
                Set <span className="mono">VITE_CLANKER_V4_ESCROW_ADDRESS</span> to your deployed{" "}
                <span className="mono">ClankerEscrowV4</span> contract and redeploy.{" "}
                Deploy with:{" "}
                <span className="mono">forge script script/DeployAddClankerV4.s.sol</span>
              </p>
            </div>
          </div>
        );
      }
      return (
        <EscrowWizardClankerV4
          row={props.row}
          clankerEscrowV4Address={ce4}
          userAddress={props.userAddress}
          onClose={props.onClose}
          onDone={props.onDone}
        />
      );
    }

    // ── Clanker v3.x ────────────────────────────────────────────────────────
    const ce = props.clankerEscrowAddress ?? clankerEscrowAddressFromEnv();
    if (!ce) {
      return (
        <div className="settings-overlay" onClick={props.onClose}>
          <div className="settings-sheet escrow-wizard" onClick={(e) => e.stopPropagation()}>
            <div className="settings-sheet__head">
              <h3>List for sale (Clanker)</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={props.onClose}>
                ✕
              </button>
            </div>
            <p className="err">
              Set <span className="mono">VITE_CLANKER_ESCROW_ADDRESS</span> to your deployed Clanker escrow contract and
              redeploy the site.
            </p>
          </div>
        </div>
      );
    }
    return (
      <EscrowWizardClanker
        row={props.row}
        clankerEscrowAddress={ce}
        userAddress={props.userAddress}
        onClose={props.onClose}
        onDone={props.onDone}
      />
    );
  }
  return <EscrowWizardBankr {...props} />;
}
