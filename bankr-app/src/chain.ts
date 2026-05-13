import { base } from "wagmi/chains";

/** MVP: Base mainnet only (real Bankr assets). Other chains are not supported in this build. */
export const MVP_CHAIN = base;
export const MVP_CHAIN_ID = base.id;

const raw = import.meta.env.VITE_CHAIN_ID;
if (typeof raw === "string" && raw.trim() !== "" && Number(raw) !== MVP_CHAIN_ID) {
  console.warn(
    `[bankr-app] VITE_CHAIN_ID=${raw} is ignored. This MVP is hardcoded to Base mainnet (${MVP_CHAIN_ID}) only.`,
  );
}
