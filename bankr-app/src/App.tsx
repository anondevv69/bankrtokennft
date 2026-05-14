import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useWriteContract,
  useChainId,
  useSwitchChain,
} from "wagmi";
import { isAddress, parseAbiItem, parseEther, formatEther, getAddress, type Address } from "viem";
import { feeRightsFixedSaleAbi } from "./lib/feeRightsFixedSaleAbi";
import { MVP_CHAIN_ID } from "./chain";

const erc721BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const erc721Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function envAddr(name: string): string {
  const raw = (import.meta as ImportMeta).env[name];
  if (typeof raw === "string" && isAddress(raw)) return raw;
  return "";
}

function hasPinnedContractsFromEnv(): boolean {
  return Boolean(envAddr("VITE_MARKETPLACE_ADDRESS") && envAddr("VITE_DEFAULT_RECEIPT_COLLECTION"));
}

export default function App() {
  const queryClient = useQueryClient();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connectPending, variables: connectVariables } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switchPending } = useSwitchChain();
  const { writeContractAsync, isPending: writePending, error: writeError } = useWriteContract();
  const publicClient = usePublicClient();

  const [mpInput, setMpInput] = useState(envAddr("VITE_MARKETPLACE_ADDRESS"));
  const [colInput, setColInput] = useState(envAddr("VITE_DEFAULT_RECEIPT_COLLECTION"));
  const [tokenIdStr, setTokenIdStr] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [scannedIds, setScannedIds] = useState<string[]>([]);
  const [scanErr, setScanErr] = useState<string | null>(null);

  const [offerEth, setOfferEth] = useState("0.01");
  const [listPriceEth, setListPriceEth] = useState("1");
  const [listingIdStr, setListingIdStr] = useState("1");
  const [buyPriceEth, setBuyPriceEth] = useState("1");
  const [acceptBidder, setAcceptBidder] = useState("");

  const marketplaceAddr = mpInput.trim();
  const collectionAddr = colInput.trim();
  const marketplaceOk = isAddress(marketplaceAddr);
  const collectionOk = isAddress(collectionAddr);
  const marketplace = marketplaceOk ? (marketplaceAddr as Address) : undefined;
  const collection = collectionOk ? (collectionAddr as Address) : undefined;

  const tokenId = useMemo(() => {
    const t = tokenIdStr.trim();
    if (!t) return null;
    try {
      return BigInt(t);
    } catch {
      return null;
    }
  }, [tokenIdStr]);

  const readsEnabled = Boolean(marketplace && collection && tokenId !== null);

  const wrongNetwork = isConnected && chainId !== MVP_CHAIN_ID;

  const scanBlockSpan = useMemo(() => {
    const raw = (import.meta as ImportMeta).env.VITE_RECEIPT_SCAN_BLOCKS;
    const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n > 0) return BigInt(Math.min(n, 500_000));
    return 80_000n;
  }, []);

  const { data: totalOffersWei } = useReadContract({
    address: readsEnabled ? marketplace : undefined,
    abi: feeRightsFixedSaleAbi,
    functionName: "totalOfferWei",
    args: readsEnabled && tokenId !== null ? [collection!, tokenId] : undefined,
    chainId: MVP_CHAIN_ID,
    query: { enabled: readsEnabled && !wrongNetwork },
  });

  const { data: myReceiptBalance } = useReadContract({
    address: collection,
    abi: erc721BalanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(collectionOk && collection && address && isConnected) },
  });

  const { data: myOfferWei } = useReadContract({
    address: readsEnabled ? marketplace : undefined,
    abi: feeRightsFixedSaleAbi,
    functionName: "offerWei",
    args: readsEnabled && tokenId !== null && address ? [collection!, tokenId, address] : undefined,
    chainId: MVP_CHAIN_ID,
    query: { enabled: readsEnabled && Boolean(address) && !wrongNetwork },
  });

  const { data: approvedSpender } = useReadContract({
    address: readsEnabled ? collection : undefined,
    abi: erc721Abi,
    functionName: "getApproved",
    args: readsEnabled && tokenId !== null ? [tokenId] : undefined,
    chainId: MVP_CHAIN_ID,
    query: { enabled: readsEnabled && tokenId !== null && !wrongNetwork },
  });

  const { data: approvedForAll } = useReadContract({
    address: readsEnabled ? collection : undefined,
    abi: erc721Abi,
    functionName: "isApprovedForAll",
    args: readsEnabled && address && marketplace ? [address, marketplace] : undefined,
    chainId: MVP_CHAIN_ID,
    query: { enabled: readsEnabled && Boolean(address) && Boolean(marketplace) && !wrongNetwork },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries();
  };

  const scanTransfersToWallet = async () => {
    if (!publicClient || !collection || !address || !collectionOk) return;
    setScanErr(null);
    setScannedIds([]);
    setScanLoading(true);
    try {
      const latest = await publicClient.getBlockNumber();
      const span = scanBlockSpan;
      const fromBlock = latest > span ? latest - span : 0n;
      const logs = await publicClient.getLogs({
        address: collection,
        event: transferEvent,
        args: { to: address },
        fromBlock,
        toBlock: latest,
      });
      const rawIds = logs.map((l) => l.args.tokenId).filter((t): t is bigint => typeof t === "bigint");
      const uniq = [...new Set(rawIds.map((x) => x.toString()))].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
      );
      setScannedIds(uniq);
    } catch (e) {
      setScanErr(
        e instanceof Error
          ? e.message
          : "Scan failed — public RPCs often cap `getLogs` range; set `VITE_RPC_URL` to a paid Base endpoint.",
      );
    } finally {
      setScanLoading(false);
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      invalidate();
    } catch {
      /* surfaced via writeError / wallet */
    }
  };

  const txDisabled = !isConnected || writePending || wrongNetwork;

  const singleTokenApproved =
    readsEnabled &&
    tokenId !== null &&
    marketplace &&
    typeof approvedSpender === "string" &&
    isAddress(approvedSpender) &&
    getAddress(approvedSpender as Address) === getAddress(marketplace);

  const operatorForAll = approvedForAll === true;

  const canMarketplacePullToken = Boolean(readsEnabled && (singleTokenApproved || operatorForAll));

  return (
    <>
      <div className="mvp-banner" role="status">
        <div className="mvp-banner__line1">Bankr MVP — Base mainnet only</div>
        <div className="mvp-banner__line2">Real assets · experimental UI · use at your own risk</div>
      </div>

      <h1>Bankr sale</h1>
      <p className="sub">
        This is a <strong>local dev console</strong> for the on-chain marketplace — not the in-Bankr Marketplace UI (that
        app reads Bankr APIs to show &quot;eligible&quot; launches). Here you paste contract addresses and token id, or
        scan recent transfers below.
      </p>

      <div className="panel quick-path-callout">
        <h2>Already minted BFRR? Skip the Bankr wizard</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          In Bankr Marketplace <strong>v1.62</strong>, <em>Sell Rights + List</em> still runs the full escrow → beneficiary →
          mint → list orchestration — that UI is <strong>not in this repo</strong>, so we cannot change that modal from
          GitHub. Ask Bankr for a <strong>&quot;List only&quot;</strong> shortcut when the wallet already holds BFRR (copy in{" "}
          <code className="mono">skills/.../dm-intents.md</code> and <code className="mono">LAUNCH_CHECKLIST.md</code> item
          7). On <strong>this page</strong>: enter <strong>token ID</strong> + <strong>list price (ETH)</strong> in the first
          panel, then <strong>Approve</strong> → <strong>List</strong> below — no escrow steps.
        </p>
      </div>

      {hasPinnedContractsFromEnv() && (
        <p className="muted" style={{ marginTop: "-0.5rem", fontSize: "0.85rem" }}>
          Railway build has <code className="mono">VITE_*</code> addresses — marketplace + BFRR fields are prefilled.
        </p>
      )}

      <div className="panel">
        <h2>Wallet</h2>
        {!isConnected ? (
          <div className="wallet-pick">
            <p className="muted" style={{ marginTop: 0 }}>
              Choose which extension or app signs txs. Same browser always reconnecting the same address?{" "}
              <strong>Disconnect</strong>, then in MetaMask (or your wallet) use the <strong>account switcher</strong>, then
              connect again. Optional: set <code className="mono">VITE_WALLETCONNECT_PROJECT_ID</code> in{" "}
              <code className="mono">.env</code> for a WalletConnect QR (mobile wallets).
            </p>
            <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem" }}>
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  type="button"
                  className="primary"
                  disabled={connectPending}
                  onClick={() => connect({ connector, chainId: MVP_CHAIN_ID })}
                >
                  {connectPending && connectVariables?.connector?.uid === connector.uid
                    ? "Connecting…"
                    : connector.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="row">
            <span className="mono muted">{address}</span>
            <span className="muted">· chain {chainId}</span>
            <button type="button" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      {wrongNetwork && (
        <div className="panel chain-gate">
          <h2>Wrong network</h2>
          <p className="err" style={{ marginTop: 0 }}>
            This app only works on <strong>Base</strong> mainnet (chain id {MVP_CHAIN_ID}). Switch in your wallet to
            continue — transactions are blocked here on other networks.
          </p>
          <button
            type="button"
            className="primary"
            disabled={switchPending}
            onClick={() => switchChain?.({ chainId: MVP_CHAIN_ID })}
          >
            {switchPending ? "Switching…" : "Switch to Base"}
          </button>
        </div>
      )}

      <>
        <div className="panel">
          <h2>List a receipt — token, price, then on-chain steps</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Enter <strong>token ID</strong> and <strong>list price</strong> first (same flow as &quot;amount then
            sale&quot;). Contract addresses stay editable; switch wallet to Base before signing.
          </p>
          <label htmlFor="mp">Marketplace contract</label>
            <input
              id="mp"
              placeholder="FeeRightsFixedSale 0x…"
              value={mpInput}
              onChange={(e) => setMpInput(e.target.value)}
            />
            <label htmlFor="col">Receipt NFT contract</label>
            <input
              id="col"
              placeholder="BankrFeeRightsReceipt 0x…"
              value={colInput}
              onChange={(e) => setColInput(e.target.value)}
            />
            <label htmlFor="tid">Token ID</label>
            <input
              id="tid"
              placeholder="Full uint256 from escrow.tokenIdFor(…)"
              value={tokenIdStr}
              onChange={(e) => setTokenIdStr(e.target.value)}
            />
            <label htmlFor="lp">Your list price (ETH)</label>
            <input
              id="lp"
              placeholder="e.g. 0.0005"
              value={listPriceEth}
              onChange={(e) => setListPriceEth(e.target.value)}
            />
            {collectionOk && isConnected && address && (
              <div className="readout" style={{ marginBottom: "0.85rem" }}>
                <div>
                  <span className="muted">BFRR balance for your wallet — </span>
                  <strong>{String(myReceiptBalance ?? "…")}</strong>
                  {wrongNetwork && (
                    <span className="muted"> (reads still use Base RPC; switch wallet to Base to send txs)</span>
                  )}
                </div>
                <div style={{ marginTop: "0.65rem", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <a
                    className="muted"
                    style={{ color: "var(--accent)" }}
                    href={`https://basescan.org/token/${collectionAddr}?a=${address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open BaseScan inventory for this collection →
                  </a>
                </div>
                <div style={{ marginTop: "0.65rem" }}>
                  <button type="button" disabled={scanLoading} onClick={() => void scanTransfersToWallet()}>
                    {scanLoading ? "Scanning logs…" : `Scan Transfer logs (last ~${scanBlockSpan} blocks)`}
                  </button>
                </div>
                {scanErr && <p className="err" style={{ marginTop: "0.5rem", marginBottom: 0 }}>{scanErr}</p>}
                {scannedIds.length > 0 && (
                  <div style={{ marginTop: "0.65rem" }}>
                    <span className="muted">Token IDs received in range (click to fill):</span>
                    <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.2rem" }}>
                      {scannedIds.map((id) => (
                        <li key={id}>
                          <button type="button" className="linkish" onClick={() => setTokenIdStr(id)}>
                            {id}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {readsEnabled && tokenId !== null && (
              <div className="readout">
                <div>
                  <span className="muted">Total ETH offered on this token — </span>
                  <strong>{formatEther((totalOffersWei as bigint | undefined) ?? 0n)}</strong>
                </div>
                {address && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <span className="muted">Your offer (locked) — </span>
                    <strong>{formatEther((myOfferWei as bigint | undefined) ?? 0n)}</strong>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Sell at a price — or cancel</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              List = you want to sell at this ETH price. Cancel = you changed your mind and get the NFT back from the
              marketplace contract. Prefer <strong>approve this token only</strong> — wallets often warn less than{" "}
              <code className="mono">setApprovalForAll</code> (entire collection).
            </p>
            {readsEnabled && tokenId !== null && (
              <p className="muted" style={{ marginTop: 0 }}>
                Approval state:{" "}
                {singleTokenApproved ? (
                  <strong style={{ color: "var(--accent)" }}>this token → marketplace</strong>
                ) : (
                  <span>not single-token approved</span>
                )}
                {operatorForAll ? (
                  <>
                    {" "}
                    · <strong style={{ color: "var(--banner-amber)" }}>operator for all</strong> (max privilege)
                  </>
                ) : null}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={txDisabled || !readsEnabled}
              onClick={() =>
                run(async () => {
                  if (!readsEnabled || !collection || !marketplace || tokenId === null) return;
                  await writeContractAsync({
                    address: collection,
                    abi: erc721Abi,
                    functionName: "approve",
                    args: [marketplace, tokenId],
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              Step 1 — Approve marketplace for this token only
            </button>
            <button
              type="button"
              style={{ marginTop: "0.5rem" }}
              disabled={txDisabled || !readsEnabled}
              onClick={() =>
                run(async () => {
                  if (!readsEnabled || !collection || !marketplace) return;
                  await writeContractAsync({
                    address: collection,
                    abi: erc721Abi,
                    functionName: "setApprovalForAll",
                    args: [marketplace, true],
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              Optional — Approve marketplace for all tokens in this collection
            </button>
            <button
              type="button"
              className="primary"
              disabled={txDisabled || !readsEnabled || !canMarketplacePullToken}
              onClick={() =>
                run(async () => {
                  if (!readsEnabled || tokenId === null || !marketplace || !collection) return;
                  await writeContractAsync({
                    address: marketplace,
                    abi: feeRightsFixedSaleAbi,
                    functionName: "list",
                    args: [collection, tokenId, parseEther(listPriceEth)],
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              List for sale
            </button>
            {!canMarketplacePullToken && readsEnabled && (
              <p className="muted" style={{ marginTop: "0.35rem", marginBottom: 0 }}>
                Complete Step 1 (single-token approve or optional collection-wide) before listing.
              </p>
            )}
            <label htmlFor="lid" style={{ marginTop: "1rem" }}>
              Listing ID (to cancel)
            </label>
            <input id="lid" value={listingIdStr} onChange={(e) => setListingIdStr(e.target.value)} />
            <button
              type="button"
              className="danger"
              disabled={txDisabled || !marketplaceOk}
              onClick={() =>
                run(async () => {
                  if (!marketplace) return;
                  await writeContractAsync({
                    address: marketplace,
                    abi: feeRightsFixedSaleAbi,
                    functionName: "cancel",
                    args: [BigInt(listingIdStr || "0")],
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              Cancel sale — I do not want to sell
            </button>
          </div>

          <div className="panel">
            <h2>Offers — optional</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Anyone can lock ETH as an offer even if you have not listed. You can accept an offer (sell to that
              bidder) or do nothing. You cannot place new offers while your token is in an active fixed listing (use
              cancel first if needed).
            </p>
            <label htmlFor="oe">Add to my offer (ETH)</label>
            <input id="oe" value={offerEth} onChange={(e) => setOfferEth(e.target.value)} />
            <button
              type="button"
              className="primary"
              disabled={txDisabled || !readsEnabled}
              onClick={() =>
                run(async () => {
                  if (!address || !readsEnabled || tokenId === null || !marketplace || !collection) return;
                  await writeContractAsync({
                    address: marketplace,
                    abi: feeRightsFixedSaleAbi,
                    functionName: "placeOffer",
                    args: [collection, tokenId],
                    value: parseEther(offerEth),
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              Send offer
            </button>
            <button
              type="button"
              style={{ marginLeft: "0.5rem" }}
              disabled={txDisabled || !readsEnabled}
              onClick={() =>
                run(async () => {
                  if (!readsEnabled || tokenId === null || !marketplace || !collection) return;
                  await writeContractAsync({
                    address: marketplace,
                    abi: feeRightsFixedSaleAbi,
                    functionName: "withdrawOffer",
                    args: [collection, tokenId],
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              Pull back my offer
            </button>
            <label htmlFor="bidder" style={{ marginTop: "1rem" }}>
              Seller: accept this bidder&apos;s address
            </label>
            <input
              id="bidder"
              placeholder="0x…"
              value={acceptBidder}
              onChange={(e) => setAcceptBidder(e.target.value)}
            />
            <button
              type="button"
              className="primary"
              disabled={txDisabled || !readsEnabled || !isAddress(acceptBidder)}
              onClick={() =>
                run(async () => {
                  if (!readsEnabled || tokenId === null || !marketplace || !collection || !isAddress(acceptBidder)) {
                    return;
                  }
                  await writeContractAsync({
                    address: marketplace,
                    abi: feeRightsFixedSaleAbi,
                    functionName: "acceptOffer",
                    args: [collection, tokenId, acceptBidder as Address],
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              Accept offer — sell to them at their locked price
            </button>
          </div>

          <div className="panel">
            <h2>Buy someone else&apos;s listing</h2>
            <label htmlFor="lid2">Listing ID</label>
            <input id="lid2" value={listingIdStr} onChange={(e) => setListingIdStr(e.target.value)} />
            <label htmlFor="bpe">ETH (must match seller&apos;s price exactly)</label>
            <input id="bpe" value={buyPriceEth} onChange={(e) => setBuyPriceEth(e.target.value)} />
            <button
              type="button"
              className="primary"
              disabled={txDisabled || !marketplaceOk}
              onClick={() =>
                run(async () => {
                  if (!marketplace) return;
                  await writeContractAsync({
                    address: marketplace,
                    abi: feeRightsFixedSaleAbi,
                    functionName: "buy",
                    args: [BigInt(listingIdStr || "0")],
                    value: parseEther(buyPriceEth),
                    chainId: MVP_CHAIN_ID,
                  });
                })
              }
            >
              Buy
            </button>
          </div>
        </>

      {writeError && <p className="err">{writeError.message}</p>}

      <p className="muted" style={{ marginTop: "2rem" }}>
        Escrow (mint receipt, redeem) is still <span className="mono">BankrEscrowV3</span> in the repo — this page is
        only the sale / offer marketplace.
      </p>
    </>
  );
}
