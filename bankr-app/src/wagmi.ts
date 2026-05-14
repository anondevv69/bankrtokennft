import { createConfig, http } from "wagmi";
import { coinbaseWallet, injected, metaMask, walletConnect } from "wagmi/connectors";
import { MVP_CHAIN } from "./chain";

/** Prefer a dedicated RPC in production (`VITE_RPC_URL`). Public endpoint is rate-limited. */
const rpc = import.meta.env.VITE_RPC_URL ?? "https://mainnet.base.org";

const wcProjectId =
  typeof import.meta.env.VITE_WALLETCONNECT_PROJECT_ID === "string"
    ? import.meta.env.VITE_WALLETCONNECT_PROJECT_ID.trim()
    : "";

/** Multiple connectors so you can pick MetaMask vs Coinbase vs another injected wallet (Rabby, etc.). */
const connectors = [
  metaMask(),
  coinbaseWallet({ appName: "Bankr sale" }),
  ...(wcProjectId
    ? [
        walletConnect({
          projectId: wcProjectId,
          metadata: {
            name: "Bankr sale",
            description: "Bankr fee rights — Base",
            url: typeof window !== "undefined" ? window.location.origin : "https://localhost",
            icons: [],
          },
          showQrModal: true,
        }),
      ]
    : []),
  injected(),
];

/** Single-chain MVP: Base (8453) only. */
export const config = createConfig({
  chains: [MVP_CHAIN],
  connectors,
  transports: {
    [MVP_CHAIN.id]: http(rpc),
  },
});
