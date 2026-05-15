/**
 * POST /api/bankr-build-transfer — proxies Bankr public helper (no auth).
 * https://docs.bankr.bot/token-launching/transferring-fees/
 *
 * Body JSON: { tokenAddress, currentBeneficiary, newBeneficiary }
 * Returns upstream JSON (to, data, chainId, description) or error.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      res.status(400).json({ ok: false, error: "Invalid JSON body" });
      return;
    }
  }
  if (!body || typeof body !== "object") {
    res.status(400).json({ ok: false, error: "Expected JSON object body" });
    return;
  }

  const { tokenAddress, currentBeneficiary, newBeneficiary } = /** @type {Record<string, unknown>} */ (body);
  for (const [k, v] of [
    ["tokenAddress", tokenAddress],
    ["currentBeneficiary", currentBeneficiary],
    ["newBeneficiary", newBeneficiary],
  ]) {
    if (typeof v !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(v.trim())) {
      res.status(400).json({ ok: false, error: `Invalid or missing ${k}` });
      return;
    }
  }

  const upstreamUrl =
    (process.env.BANKR_BUILD_TRANSFER_URL || "").trim() ||
    "https://api.bankr.bot/public/doppler/build-transfer-beneficiary";

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "BankrSale/1.0",
      },
      body: JSON.stringify({
        tokenAddress: tokenAddress.trim(),
        currentBeneficiary: currentBeneficiary.trim(),
        newBeneficiary: newBeneficiary.trim(),
      }),
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: "Upstream fetch failed", detail: String(e) });
    return;
  }

  const ct = upstream.headers.get("content-type") || "";
  let out;
  try {
    out = ct.includes("application/json") ? await upstream.json() : await upstream.text();
  } catch {
    out = null;
  }

  if (!upstream.ok) {
    let extracted = "Bankr build-transfer returned an error";
    if (out && typeof out === "object") {
      if (typeof out.error === "string") extracted = out.error;
      else if (typeof out.message === "string") extracted = out.message;
    } else if (typeof out === "string" && out.trim()) {
      extracted = out.trim().slice(0, 500);
    }
    res.status(200).json({
      ok: false,
      error: extracted,
      status: upstream.status,
      body: typeof out === "string" ? out.slice(0, 2000) : out,
    });
    return;
  }

  res.status(200).json({ ok: true, data: out });
}
