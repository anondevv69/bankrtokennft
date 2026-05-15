import { getAddress, isAddress, type Address } from "viem";

/** Bankr escrow — `VITE_ESCROW_ADDRESS` legacy name; falls back to `VITE_BANKR_ESCROW_ADDRESS`. */
export function bankrEscrowAddressFromEnv(): Address {
  // Must read `import.meta.env.VITE_*` directly — assigning `import.meta` to a variable breaks Vite’s env injection (`meta.env` is undefined in production).
  for (const raw of [
    import.meta.env.VITE_ESCROW_ADDRESS,
    import.meta.env.VITE_BANKR_ESCROW_ADDRESS,
  ] as const) {
    if (typeof raw === "string") {
      const t = raw.trim();
      if (t.startsWith("0x") && isAddress(t)) return getAddress(t);
    }
  }
  return getAddress("0x7BD14E540Ac55E229587Bf3Cd0Fc815A7afcf461");
}

/** Clanker escrow — optional until wired / deployed. */
export function clankerEscrowAddressFromEnv(): Address | null {
  const raw = import.meta.env.VITE_CLANKER_ESCROW_ADDRESS?.trim();
  if (!raw?.startsWith("0x") || !isAddress(raw)) return null;
  return getAddress(raw);
}

/** Default Clanker `LpLockerv2` when listing without authenticated token metadata (Base mainnet v3.1). Override via env for other eras/factories. */
export function clankerDefaultLockerFromEnv(): Address | null {
  const raw = import.meta.env.VITE_CLANKER_DEFAULT_LOCKER?.trim();
  if (raw?.startsWith("0x") && isAddress(raw)) return getAddress(raw);
  return getAddress("0x33e2Eda238edcF470309b8c6D228986A1204c8f9");
}
