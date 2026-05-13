import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWriteContract,
  useChainId,
  useSwitchChain,
} from "wagmi";
import { injected } from "wagmi/connectors";
import { isAddress, parseEther, formatEther, type Address } from "viem";
import { feeRightsFixedSaleAbi } from "./lib/feeRightsFixedSaleAbi";
import { MVP_CHAIN_ID } from "./chain";

const erc721Abi = [
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
] as const;

function envAddr(name: string): string {
  const raw = (import.meta as ImportMeta).env[name];
  if (typeof raw === "string" && isAddress(raw)) return raw;
  return "";
}

export default function App() {
  const queryClient = useQueryClient();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, isPending: connectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switchPending } = useSwitchChain();
  const { writeContractAsync, isPending: writePending, error: writeError } = useWriteContract();

  const [mpInput, setMpInput] = useState(envAddr("VITE_MARKETPLACE_ADDRESS"));
  const [colInput, setColInput] = useState(envAddr("VITE_DEFAULT_RECEIPT_COLLECTION"));
  const [tokenIdStr, setTokenIdStr] = useState("");

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

  const { data: totalOffersWei } = useReadContract({
    address: readsEnabled ? marketplace : undefined,
    abi: feeRightsFixedSaleAbi,
    functionName: "totalOfferWei",
    args: readsEnabled && tokenId !== null ? [collection!, tokenId] : undefined,
    chainId: MVP_CHAIN_ID,
    query: { enabled: readsEnabled && !wrongNetwork },
  });

  const { data: myOfferWei } = useReadContract({
    address: readsEnabled ? marketplace : undefined,
    abi: feeRightsFixedSaleAbi,
    functionName: "offerWei",
    args: readsEnabled && tokenId !== null && address ? [collection!, tokenId, address] : undefined,
    chainId: MVP_CHAIN_ID,
    query: { enabled: readsEnabled && Boolean(address) && !wrongNetwork },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries();
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

  return (
    <>
      <div className="mvp-banner" role="status">
        <div className="mvp-banner__line1">Testnet MVP — Base Sepolia only</div>
        <div className="mvp-banner__line2">Experimental · not audited · no mainnet</div>
      </div>

      <h1>Bankr sale</h1>
      <p className="sub">
        Simple flow: <strong>sell</strong> at a fixed price (or <strong>cancel</strong> the sale), or let people{" "}
        <strong>offer</strong> ETH — you can <strong>accept</strong> an offer or ignore it. No auctions, buybacks, or
        routing. Wallet-only signing — never paste private keys here or in Railway.
      </p>

      <div className="panel">
        <h2>Wallet</h2>
        {!isConnected ? (
          <button
            type="button"
            className="primary"
            disabled={connectPending}
            onClick={() => connect({ connector: injected(), chainId: MVP_CHAIN_ID })}
          >
            {connectPending ? "Connecting…" : "Connect wallet (Base Sepolia)"}
          </button>
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
            This app only works on <strong>Base Sepolia</strong> (chain id {MVP_CHAIN_ID}). Switch in your wallet to
            continue — transactions are blocked here to avoid mistakes on mainnet or other chains.
          </p>
          <button
            type="button"
            className="primary"
            disabled={switchPending}
            onClick={() => switchChain?.({ chainId: MVP_CHAIN_ID })}
          >
            {switchPending ? "Switching…" : "Switch to Base Sepolia"}
          </button>
        </div>
      )}

      {!wrongNetwork && (
        <>
          <div className="panel">
            <h2>Which token</h2>
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
              placeholder="e.g. 12345"
              value={tokenIdStr}
              onChange={(e) => setTokenIdStr(e.target.value)}
            />
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
              marketplace contract.
            </p>
            <button
              type="button"
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
              Step 1 — Approve marketplace on your receipt
            </button>
            <label htmlFor="lp" style={{ marginTop: "1rem" }}>
              Your sale price (ETH)
            </label>
            <input id="lp" value={listPriceEth} onChange={(e) => setListPriceEth(e.target.value)} />
            <button
              type="button"
              className="primary"
              disabled={txDisabled || !readsEnabled}
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
      )}

      {writeError && <p className="err">{writeError.message}</p>}

      <p className="muted" style={{ marginTop: "2rem" }}>
        Escrow (mint receipt, redeem) is still <span className="mono">BankrEscrowV3</span> in the repo — this page is
        only the sale / offer marketplace.
      </p>
    </>
  );
}
