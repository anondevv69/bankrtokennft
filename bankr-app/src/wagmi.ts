import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { MVP_CHAIN } from "./chain";

const rpc = import.meta.env.VITE_RPC_URL ?? "https://sepolia.base.org";

/** Single-chain MVP: no mainnet, no other testnets. */
export const config = createConfig({
  chains: [MVP_CHAIN],
  connectors: [injected()],
  transports: {
    [MVP_CHAIN.id]: http(rpc),
  },
});
