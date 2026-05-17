import { base, baseSepolia } from "wagmi/chains";
import type { Chain } from "wagmi/chains";

/** Allow Base Sepolia for local/testnet dev via VITE_CHAIN_ID=84532. */
const rawChainId =
  typeof import.meta.env.VITE_CHAIN_ID === "string"
    ? Number(import.meta.env.VITE_CHAIN_ID.trim())
    : base.id;

const SUPPORTED: Record<number, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
};

export const MVP_CHAIN: Chain = SUPPORTED[rawChainId] ?? base;
export const MVP_CHAIN_ID: number = MVP_CHAIN.id;

if (MVP_CHAIN_ID !== base.id) {
  console.info(
    `[bankr-app] Running on ${MVP_CHAIN.name} (${MVP_CHAIN_ID}) — testnet/dev mode.`,
  );
}
