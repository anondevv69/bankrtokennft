/** Client-rendered fee-rights receipt image (ticker + token name, no WETH pair line). */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export type BfrrPreviewOpts = {
  serial: string;
  ticker: string;
  tokenName?: string | null;
  factory?: string | null;
  poolId?: string | null;
  seller?: string | null;
  feeManager?: string | null;
};

/** Matches on-chain receipt card layout; omits WETH from the pair headline. */
export function bfrrReceiptPreviewDataUri(opts: BfrrPreviewOpts): string {
  const serial = esc(clip(opts.serial, 8));
  const ticker = esc(clip(opts.ticker, 14));
  const tokenName = esc(clip((opts.tokenName?.trim() || opts.ticker).trim(), 22));
  const fact = esc(clip((opts.factory?.trim() || "Unknown").toUpperCase(), 12));
  const pool = opts.poolId ? esc(clip(opts.poolId, 16)) : "—";
  const seller = opts.seller ? esc(clip(opts.seller, 16)) : "—";
  const feeMgr = opts.feeManager ? esc(clip(opts.feeManager, 16)) : "—";
  const showName = tokenName.toLowerCase() !== ticker.toLowerCase();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 300">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#050508"/>
<stop offset="0.5" stop-color="#0f0f14"/>
<stop offset="1" stop-color="#1a0f18"/>
</linearGradient>
<linearGradient id="chip" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#fb923c"/>
<stop offset="1" stop-color="#ea580c"/>
</linearGradient>
</defs>
<rect width="420" height="300" fill="url(#bg)" rx="20"/>
<circle cx="332" cy="228" r="118" fill="#f97316" fill-opacity="0.07"/>
<circle cx="64" cy="256" r="76" fill="#7c3aed" fill-opacity="0.045"/>
<rect x="1" y="1" width="418" height="298" rx="19" fill="none" stroke="#3f3f46" stroke-opacity="0.85" stroke-width="1"/>
<rect x="18" y="48" width="384" height="236" rx="16" fill="#09090b" stroke="#f97316" stroke-opacity="0.25" stroke-width="1"/>
<rect x="286" y="58" width="100" height="28" rx="14" fill="url(#chip)" fill-opacity="0.18" stroke="#fdba74" stroke-opacity="0.45"/>
<text x="336" y="77" font-family="ui-monospace,monospace" font-size="10" fill="#fff7ed" text-anchor="middle" font-weight="700" letter-spacing="1.1">${fact}</text>
<text x="32" y="82" font-family="ui-monospace,monospace" font-size="12" fill="#a1a1aa" font-weight="600">CREATOR FEE RIGHTS</text>
<text x="32" y="118" font-family="ui-monospace,monospace" font-size="30" fill="#fafafa" font-weight="800">CFR #${serial}</text>
<rect x="32" y="130" width="356" height="${showName ? 58 : 48}" rx="12" fill="#18181b" stroke="#27272f" stroke-width="1"/>
<text x="48" y="152" font-family="ui-monospace,monospace" font-size="9" fill="#71717a" font-weight="600">TICKER</text>
<text x="48" y="172" font-family="ui-monospace,monospace" font-size="20" fill="#fdba74" font-weight="700">${ticker}</text>
${showName ? `<text x="210" y="152" font-family="ui-monospace,monospace" font-size="9" fill="#71717a" font-weight="600">TOKEN NAME</text><text x="210" y="172" font-family="ui-monospace,monospace" font-size="14" fill="#e4e4e7" font-weight="600">${tokenName}</text>` : ""}
<line x1="32" y1="${showName ? 200 : 194}" x2="388" y2="${showName ? 200 : 194}" stroke="#27272f" stroke-width="1"/>
<text x="32" y="218" font-family="ui-monospace,monospace" font-size="10" fill="#71717a" font-weight="600">POOL ID</text>
<text x="118" y="218" font-family="ui-monospace,monospace" font-size="10" fill="#e4e4e7">${pool}</text>
<text x="32" y="242" font-family="ui-monospace,monospace" font-size="10" fill="#71717a" font-weight="600">SELLER</text>
<text x="118" y="242" font-family="ui-monospace,monospace" font-size="10" fill="#e4e4e7">${seller}</text>
<text x="32" y="266" font-family="ui-monospace,monospace" font-size="10" fill="#71717a" font-weight="600">FEE MGR</text>
<text x="118" y="266" font-family="ui-monospace,monospace" font-size="10" fill="#e4e4e7">${feeMgr}</text>
<line x1="32" y1="278" x2="388" y2="278" stroke="#27272f" stroke-width="1"/>
<text x="32" y="292" font-family="ui-monospace,monospace" font-size="9" fill="#52525b">Token Marketplace · Base</text>
<text x="388" y="292" font-family="ui-monospace,monospace" font-size="9" fill="#52525b" text-anchor="end">#${serial}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
