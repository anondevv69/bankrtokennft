/** Parse on-chain TMPR `tokenURI` (data:application/json;base64,…). */

export function traitFromReceiptUri(
  tokenUri: unknown,
  traitType: string,
): string | undefined {
  const attrs = parseReceiptAttributes(tokenUri);
  if (!attrs) return undefined;
  const want = traitType.toLowerCase();
  for (const a of attrs) {
    const t = a.trait_type;
    if (typeof t === "string" && t.toLowerCase() === want && typeof a.value === "string") {
      const v = a.value.trim();
      if (v) return v;
    }
  }
  return undefined;
}

function parseReceiptAttributes(tokenUri: unknown): { trait_type?: string; value?: string }[] | null {
  if (!tokenUri || typeof tokenUri !== "string") return null;
  if (!tokenUri.toLowerCase().startsWith("data:application/json")) return null;
  const m = /;base64,(.+)$/i.exec(tokenUri);
  if (!m?.[1]) return null;
  try {
    const json = JSON.parse(atob(m[1])) as { attributes?: unknown };
    return Array.isArray(json.attributes) ? (json.attributes as { trait_type?: string; value?: string }[]) : null;
  } catch {
    return null;
  }
}
