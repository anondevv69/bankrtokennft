import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { MVP_CHAIN } from "./chain";

/** Prefer a dedicated RPC in production (`VITE_RPC_URL`). Public endpoint is rate-limited. */
const rpc =
  typeof import.meta.env.VITE_RPC_URL === "string" && import.meta.env.VITE_RPC_URL.trim()
    ? import.meta.env.VITE_RPC_URL.trim()
    : "https://mainnet.base.org";

if (typeof import.meta.env.DEV !== "undefined" && import.meta.env.DEV && rpc.includes("mainnet.base.org")) {
  console.warn(
    "[token-marketplace] VITE_RPC_URL is unset or points at mainnet.base.org — receipt scans may hit rate limits. Use a dedicated Base RPC in bankr-app/.env.",
  );
}

/** Reown / WalletConnect Cloud project id (free). Either env name works. Required for RainbowKit + mobile wallets. */
const wcProjectIdRaw =
  (typeof import.meta.env.VITE_WALLETCONNECT_PROJECT_ID === "string"
    ? import.meta.env.VITE_WALLETCONNECT_PROJECT_ID.trim()
    : "") ||
  (typeof import.meta.env.VITE_REOWN_PROJECT_ID === "string" ? import.meta.env.VITE_REOWN_PROJECT_ID.trim() : "");

export const walletConnectConfigured = wcProjectIdRaw.length > 0;

if (!walletConnectConfigured && typeof import.meta.env.DEV !== "undefined" && import.meta.env.DEV) {
  console.warn(
    "[token-marketplace] Set VITE_WALLETCONNECT_PROJECT_ID (free at https://cloud.reown.com) for WalletConnect / QR wallets in RainbowKit.",
  );
}

/** Single-chain MVP: Base (8453) only — RainbowKit handles wallet list + connect UI. */
export const config = getDefaultConfig({
  appName: "Token Marketplace",
  projectId: walletConnectConfigured ? wcProjectIdRaw : "00000000000000000000000000000000",
  chains: [MVP_CHAIN],
  transports: {
    [MVP_CHAIN.id]: http(rpc),
  },
  ssr: false,
});
