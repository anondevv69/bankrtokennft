import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { MVP_CHAIN } from "./chain";

/** Prefer a dedicated RPC in production (`VITE_RPC_URL`). Public endpoint is rate-limited. */
const rpc = import.meta.env.VITE_RPC_URL ?? "https://mainnet.base.org";

/** Single-chain MVP: Base (8453) only. */
export const config = createConfig({
  chains: [MVP_CHAIN],
  connectors: [injected()],
  transports: {
    [MVP_CHAIN.id]: http(rpc),
  },
});
