import { baseSepolia } from "wagmi/chains";

/** MVP: Base Sepolia only. Mainnet and other chains are not supported in this build. */
export const MVP_CHAIN = baseSepolia;
export const MVP_CHAIN_ID = baseSepolia.id;

const raw = import.meta.env.VITE_CHAIN_ID;
if (typeof raw === "string" && raw.trim() !== "" && Number(raw) !== MVP_CHAIN_ID) {
  console.warn(
    `[bankr-app] VITE_CHAIN_ID=${raw} is ignored. This MVP is hardcoded to Base Sepolia (${MVP_CHAIN_ID}) only.`,
  );
}
