import { useCallback, useEffect, useState } from "react";
import type { PublicClient } from "viem";
import { getAddress, type Address, type Hex, isHex } from "viem";
import type { Config } from "wagmi";
import { useChainId, useConfig, usePublicClient, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { MVP_CHAIN, MVP_CHAIN_ID } from "./chain";
import { bankrEscrowAbi } from "./lib/bankrEscrowAbi";
import { bankrFeesMinimalAbi } from "./lib/bankrFeesMinimalAbi";
import { inferToken0Token1, normalizePoolId, rowLaunchedToken } from "./lib/escrowArgs";

export type EscrowWizardProps = {
  row: Record<string, unknown>;
  escrowAddress: Address;
  userAddress: Address;
  onClose: () => void;
  /** After successful finalize — parent should rescan BFRRs. */
  onDone: () => void;
};

function rowLabel(row: Record<string, unknown>): string {
  for (const k of ["tokenSymbol", "symbol", "name"]) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "Token";
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
        "This build’s escrow isn’t allowlisted for this pool’s fee manager. Set VITE_ESCROW_ADDRESS to your live BankrEscrowV3 and rebuild, or ask the escrow owner to allowlist this fee manager.",
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
        "Your wallet has no fee-manager shares for this pool. You must be the current beneficiary on-chain (check Bankr / claimable-fees).",
    };
  }
  return { kind: "prepare" };
}

async function readWalletChainId(config: Config): Promise<number | undefined> {
  try {
    const wc = await getWalletClient(config);
    return await wc.getChainId();
  } catch {
    return undefined;
  }
}

export function EscrowWizard({ row, escrowAddress, userAddress, onClose, onDone }: EscrowWizardProps) {
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
    const pid = normalizePoolId(row.poolId);
    const launched = rowLaunchedToken(row);
    if (!pid || !launched) {
      setNext({ kind: "blocked", reason: "This row is missing a valid poolId or tokenAddress from Bankr." });
      return;
    }
    setPoolId(pid);
    const [t0, t1] = inferToken0Token1(launched);
    setToken0(t0);
    setToken1(t1);

    let fm: Address;
    let txTo: Address;
    let txData: Hex;
    let chainId: number;
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
      if (!json.ok || !json.data || typeof json.data.to !== "string" || typeof json.data.data !== "string") {
        let detail = json.error || `HTTP ${res.status}`;
        if (json.body && typeof json.body === "object" && "error" in json.body) {
          detail = String((json.body as { error?: string }).error);
        }
        setNext({ kind: "blocked", reason: `Could not build beneficiary transfer: ${detail}` });
        return;
      }
      if (!isHex(json.data.data)) {
        setNext({ kind: "blocked", reason: "Bankr returned invalid calldata." });
        return;
      }
      fm = getAddress(json.data.to);
      txTo = getAddress(json.data.to);
      txData = json.data.data;
      chainId = typeof json.data.chainId === "number" ? json.data.chainId : MVP_CHAIN_ID;
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

    setFeeManager(fm);
    const payload = { to: txTo, data: txData, chainId };
    setTransferPayload(payload);

    try {
      const s = await readEscrowState(publicClient, escrowAddress, fm, pid, userAddress);
      setNext(deriveNext(s, userAddress, payload));
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
  const ensureBase = useCallback(async () => {
    let walletChain = await readWalletChainId(config);
    if (walletChain === MVP_CHAIN_ID) return;

    if (!switchChainAsync) {
      throw new Error(
        `Your wallet is on chain ${walletChain ?? "unknown"}, not Base (${MVP_CHAIN_ID}). Open your wallet (e.g. MetaMask) and switch the network to Base, then try again.`,
      );
    }

    await switchChainAsync({ chainId: MVP_CHAIN_ID });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      walletChain = await readWalletChainId(config);
      if (walletChain === MVP_CHAIN_ID) return;
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(
      `Still not on Base after switching (wallet reports chain ${walletChain ?? "unknown"}). In MetaMask use the network menu and pick Base mainnet (chain ${MVP_CHAIN_ID}), then try again.`,
    );
  }, [config, switchChainAsync]);

  const runPrepare = async () => {
    if (!feeManager || !poolId || !token0 || !token1) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      await writeContractAsync({
        address: escrowAddress,
        abi: bankrEscrowAbi,
        functionName: "prepareDeposit",
        args: [feeManager, poolId, token0, token1],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "prepareDeposit failed");
    } finally {
      setBusy(false);
    }
  };

  const runTransfer = async () => {
    if (!transferPayload) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      await sendTransactionAsync({
        to: transferPayload.to,
        data: transferPayload.data,
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
      await new Promise((r) => setTimeout(r, 2500));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transfer tx failed");
    } finally {
      setBusy(false);
    }
  };

  const runFinalize = async () => {
    if (!poolId) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      await writeContractAsync({
        address: escrowAddress,
        abi: bankrEscrowAbi,
        functionName: "finalizeDeposit",
        args: [poolId],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
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
    if (!poolId) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureBase();
      await writeContractAsync({
        address: escrowAddress,
        abi: bankrEscrowAbi,
        functionName: "cancelPendingDeposit",
        args: [poolId],
        chain: MVP_CHAIN,
        chainId: MVP_CHAIN_ID,
      });
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
  const label = rowLabel(row);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-sheet escrow-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="settings-sheet__head">
          <h3>Sell</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.5rem" }}>
          <strong>{label}</strong> — three <strong>Sell</strong> confirmations in your wallet (then you can list).
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

        {next.kind === "loading" && (
          <p className="muted">
            <span className="spinner" /> Checking…
          </p>
        )}

        {err && <p className="err">{err}</p>}

        {next.kind === "blocked" && next.reason && <p className="err">{next.reason}</p>}

        {next.kind === "already_escrowed" && (
          <p className="muted">Already done on-chain — use your BFRR below.</p>
        )}

        {next.kind === "prepare" && (
          <div className="escrow-wizard__step">
            <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => void runPrepare()}>
              {pending ? "…" : "Sell"}
            </button>
          </div>
        )}

        {next.kind === "transfer" && (
          <div className="escrow-wizard__step">
            <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => void runTransfer()}>
              {pending ? "…" : "Sell"}
            </button>
          </div>
        )}

        {next.kind === "finalize" && (
          <div className="escrow-wizard__step">
            <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => void runFinalize()}>
              {pending ? "…" : "Sell"}
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

        <p className="muted" style={{ fontSize: "0.72rem", marginTop: "0.75rem" }}>
          <a href="https://docs.bankr.bot/token-launching/transferring-fees/" target="_blank" rel="noreferrer">
            Help
          </a>
        </p>
      </div>
    </div>
  );
}
