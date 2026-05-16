import { useMemo } from "react";
import { useReadContract } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import { bankrFeeRightsReceiptAbi } from "./bankrFeeRightsReceiptAbi";
import { MVP_CHAIN_ID } from "../chain";
import { formatBankrPoolLabels, launchedTokenFromWethPair, normalizeLaunchedTicker } from "./escrowArgs";
import { traitFromReceiptUri } from "./receiptTokenUri";

const erc20SymbolAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const erc20NameAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export type ReceiptListingMeta = {
  loading: boolean;
  serialLabel: string | null;
  ticker: string | null;
  tokenName: string | null;
  launchFactory: string | null;
  /** Launched ERC-20 (Clanker/Bankr coin contract on Base). */
  launchedToken: Address | null;
};

export function useReceiptListingMeta(
  collection: Address | undefined,
  tokenId: string | bigint | null | undefined,
): ReceiptListingMeta {
  const enabled = Boolean(collection && tokenId !== null && tokenId !== undefined);
  const tokenIdArg = enabled ? BigInt(tokenId!) : 0n;

  const { data: serial, isLoading: l0 } = useReadContract({
    address: collection,
    abi: bankrFeeRightsReceiptAbi,
    functionName: "serialOf",
    args: [tokenIdArg],
    chainId: MVP_CHAIN_ID,
    query: { enabled, staleTime: 60_000 },
  });

  const { data: position, isLoading: l1 } = useReadContract({
    address: collection,
    abi: bankrFeeRightsReceiptAbi,
    functionName: "positionOf",
    args: [tokenIdArg],
    chainId: MVP_CHAIN_ID,
    query: { enabled, staleTime: 60_000 },
  });

  const { data: rawUri, isLoading: l2 } = useReadContract({
    address: collection,
    abi: bankrFeeRightsReceiptAbi,
    functionName: "tokenURI",
    args: [tokenIdArg],
    chainId: MVP_CHAIN_ID,
    query: { enabled, staleTime: 60_000 },
  });

  const t0 = useMemo(() => {
    if (!position || typeof position.token0 !== "string" || !isAddress(position.token0, { strict: false }))
      return undefined;
    try {
      return getAddress(position.token0);
    } catch {
      return undefined;
    }
  }, [position]);

  const t1 = useMemo(() => {
    if (!position || typeof position.token1 !== "string" || !isAddress(position.token1, { strict: false }))
      return undefined;
    try {
      return getAddress(position.token1);
    } catch {
      return undefined;
    }
  }, [position]);

  const { data: sym0 } = useReadContract({
    address: t0,
    abi: erc20SymbolAbi,
    functionName: "symbol",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t0) },
  });
  const { data: sym1 } = useReadContract({
    address: t1,
    abi: erc20SymbolAbi,
    functionName: "symbol",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t1) },
  });
  const { data: nm0 } = useReadContract({
    address: t0,
    abi: erc20NameAbi,
    functionName: "name",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t0) },
  });
  const { data: nm1 } = useReadContract({
    address: t1,
    abi: erc20NameAbi,
    functionName: "name",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t1) },
  });

  return useMemo((): ReceiptListingMeta => {
    const loading = enabled && (l0 || l1 || l2);
    const serialLabel = serial !== undefined ? `#${String(serial)}` : null;

    const sym0s = typeof sym0 === "string" && sym0.trim() ? sym0.trim() : null;
    const sym1s = typeof sym1 === "string" && sym1.trim() ? sym1.trim() : null;
    const nm0s = typeof nm0 === "string" && nm0.trim() ? nm0.trim() : null;
    const nm1s = typeof nm1 === "string" && nm1.trim() ? nm1.trim() : null;

    const poolLabels = t0 && t1 ? formatBankrPoolLabels(t0, t1, sym0s, sym1s, nm0s, nm1s) : null;
    const launchedFromPair =
      t0 && t1 ? launchedTokenFromWethPair(t0, t1) : undefined;

    const factoryOnChain =
      position && typeof position.factoryName === "string" && position.factoryName.trim()
        ? position.factoryName.trim()
        : null;

    const ticker =
      poolLabels?.ticker ||
      traitFromReceiptUri(rawUri, "Ticker") ||
      normalizeLaunchedTicker(traitFromReceiptUri(rawUri, "Pair")) ||
      null;

    const tokenName =
      poolLabels?.tokenName ||
      traitFromReceiptUri(rawUri, "Token Name") ||
      ticker;

    const launchFactory =
      factoryOnChain || traitFromReceiptUri(rawUri, "Launch factory") || null;

    const launchedToken = poolLabels?.launched ?? launchedFromPair ?? null;

    return {
      loading,
      serialLabel,
      ticker,
      tokenName,
      launchFactory,
      launchedToken,
    };
  }, [enabled, l0, l1, l2, serial, position, rawUri, sym0, sym1, nm0, nm1, t0, t1]);
}
