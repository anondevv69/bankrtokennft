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

/** Default Clanker v3.x `LpLockerv2` for manual listing without authenticated token metadata. Defaults to Base mainnet v3.1. Override via env for other eras. */
export function clankerDefaultLockerFromEnv(): Address | null {
  const raw = import.meta.env.VITE_CLANKER_DEFAULT_LOCKER?.trim();
  if (raw?.startsWith("0x") && isAddress(raw)) return getAddress(raw);
  return getAddress("0x33e2Eda238edcF470309b8c6D228986A1204c8f9");
}

/** Default Clanker v4 locker for manual listing. Defaults to Base mainnet `ClankerLpLockerFeeConversion`. Override via env. */
export function clankerV4DefaultLockerFromEnv(): Address | null {
  const raw = import.meta.env.VITE_CLANKER_V4_DEFAULT_LOCKER?.trim();
  if (raw?.startsWith("0x") && isAddress(raw)) return getAddress(raw);
  return getAddress("0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496");
}

/** Deployed `ClankerEscrowV4` contract address — optional until deployed. */
export function clankerEscrowV4AddressFromEnv(): Address | null {
  const raw = import.meta.env.VITE_CLANKER_V4_ESCROW_ADDRESS?.trim();
  if (!raw?.startsWith("0x") || !isAddress(raw)) return null;
  return getAddress(raw);
}
