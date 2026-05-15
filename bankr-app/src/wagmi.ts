import { createConfig, http } from "wagmi";
import { coinbaseWallet, injected, metaMask, walletConnect } from "wagmi/connectors";
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

/** Reown / WalletConnect Cloud project id (free). Either env name works. */
const wcProjectIdRaw =
  (typeof import.meta.env.VITE_WALLETCONNECT_PROJECT_ID === "string"
    ? import.meta.env.VITE_WALLETCONNECT_PROJECT_ID.trim()
    : "") ||
  (typeof import.meta.env.VITE_REOWN_PROJECT_ID === "string" ? import.meta.env.VITE_REOWN_PROJECT_ID.trim() : "");

/** `true` when WalletConnect (QR / mobile) is registered — requires a Cloud project id. */
export const walletConnectConfigured = wcProjectIdRaw.length > 0;

const walletConnectConnector = walletConnectConfigured
  ? walletConnect({
      projectId: wcProjectIdRaw,
      metadata: {
        name: "Token Marketplace",
        description: "Token Marketplace — Base",
        url: typeof window !== "undefined" ? window.location.origin : "https://localhost",
        icons: [],
      },
      showQrModal: true,
    })
  : null;

/**
 * MetaMask and Coinbase first; WalletConnect next (QR / Trust / Rainbow / etc.); injected last
 * (Rabby, Brave, other EIP-1193 wallets). WalletConnect only appears when `walletConnectConfigured`.
 */
const connectors = [
  metaMask(),
  ...(walletConnectConnector ? [walletConnectConnector] : []),
  coinbaseWallet({ appName: "Token Marketplace" }),
  injected({ shimDisconnect: true }),
];

/** Single-chain MVP: Base (8453) only. */
export const config = createConfig({
  chains: [MVP_CHAIN],
  connectors,
  transports: {
    [MVP_CHAIN.id]: http(rpc),
  },
});
