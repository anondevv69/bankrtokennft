import type { Config } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { MVP_CHAIN_ID } from "./chain";

export async function readWalletChainId(config: Config): Promise<number | undefined> {
  try {
    const wc = await getWalletClient(config);
    return await wc.getChainId();
  } catch {
    return undefined;
  }
}

/** Align the signing wallet with Base before sending transactions. */
export async function ensureBaseChain(
  config: Config,
  switchChainAsync?: (args: { chainId: number }) => Promise<unknown>,
): Promise<void> {
  let walletChain = await readWalletChainId(config);
  if (walletChain === MVP_CHAIN_ID) return;

  if (!switchChainAsync) {
    throw new Error(
      `Your wallet is on chain ${walletChain ?? "unknown"}, not Base (${MVP_CHAIN_ID}). Open your wallet and switch to Base mainnet, then try again.`,
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
    `Still not on Base after switching (wallet reports chain ${walletChain ?? "unknown"}). Pick Base mainnet (chain ${MVP_CHAIN_ID}) in your wallet, then try again.`,
  );
}

const RECEIPT_TIMEOUT_MS = 120_000;

export async function waitForBaseReceipt(
  publicClient: { waitForTransactionReceipt: (args: { hash: `0x${string}`; chainId: number; timeout?: number }) => Promise<unknown> },
  hash: `0x${string}`,
): Promise<void> {
  await publicClient.waitForTransactionReceipt({
    hash,
    chainId: MVP_CHAIN_ID,
    timeout: RECEIPT_TIMEOUT_MS,
  });
}

export function formatTxError(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message;
    if (/user rejected|denied|cancelled|canceled/i.test(msg)) {
      return "Transaction cancelled in your wallet. Open your wallet extension (e.g. Coinbase) if you did not see a prompt, then try again.";
    }
    if (/timeout|timed out/i.test(msg)) {
      return "Base did not confirm within two minutes. Check your wallet activity and BaseScan; you can retry if the transaction did not land.";
    }
    return msg.length > 280 ? `${msg.slice(0, 280)}…` : msg;
  }
  return "Transaction failed. Check your wallet and try again.";
}
