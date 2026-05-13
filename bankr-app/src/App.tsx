import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useWriteContract,
  useChainId,
} from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { isAddress, parseEther, formatEther, type Address } from "viem";
import { feeRightsFixedSaleAbi } from "./lib/feeRightsFixedSaleAbi";

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

  const { data: totalOffersWei } = useReadContract({
    address: readsEnabled ? marketplace : undefined,
    abi: feeRightsFixedSaleAbi,
    functionName: "totalOfferWei",
    args: readsEnabled && tokenId !== null ? [collection!, tokenId] : undefined,
    chainId: baseSepolia.id,
    query: { enabled: readsEnabled },
  });

  const { data: myOfferWei } = useReadContract({
    address: readsEnabled ? marketplace : undefined,
    abi: feeRightsFixedSaleAbi,
    functionName: "offerWei",
    args: readsEnabled && tokenId !== null && address ? [collection!, tokenId, address] : undefined,
    chainId: baseSepolia.id,
    query: { enabled: readsEnabled && Boolean(address) },
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

  const wrongChain = isConnected && chainId !== baseSepolia.id;

  return (
    <>
      <h1>Bankr fee-rights</h1>
      <p className="sub">
        Base Sepolia — receipt offers and fixed listings against <span className="mono">FeeRightsFixedSale</span>.
        Configure addresses below (or set <span className="mono">VITE_*</span> in <span className="mono">.env</span>).
      </p>

      <div className="panel">
        <h2>Wallet</h2>
        {wrongChain && (
          <p className="err">Switch your wallet to Base Sepolia (chain 84532).</p>
        )}
        {!isConnected ? (
          <button
            type="button"
            className="primary"
            disabled={connectPending}
            onClick={() => connect({ connector: injected() })}
          >
            {connectPending ? "Connecting…" : "Connect wallet"}
          </button>
        ) : (
          <div className="row">
            <span className="mono muted">{address}</span>
            <button type="button" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Contracts</h2>
        <label htmlFor="mp">Marketplace (FeeRightsFixedSale)</label>
        <input
          id="mp"
          placeholder="0x…"
          value={mpInput}
          onChange={(e) => setMpInput(e.target.value)}
        />
        <label htmlFor="col">Receipt collection (ERC721)</label>
        <input
          id="col"
          placeholder="BankrFeeRightsReceipt address"
          value={colInput}
          onChange={(e) => setColInput(e.target.value)}
        />
        <label htmlFor="tid">Token ID</label>
        <input id="tid" placeholder="e.g. 12345" value={tokenIdStr} onChange={(e) => setTokenIdStr(e.target.value)} />
        {readsEnabled && tokenId !== null && (
          <div className="readout">
            <div>
              <span className="muted">Total offer ETH on this NFT — </span>
              <strong>{formatEther((totalOffersWei as bigint | undefined) ?? 0n)}</strong>
            </div>
            {address && (
              <div style={{ marginTop: "0.5rem" }}>
                <span className="muted">Your locked offer — </span>
                <strong>{formatEther((myOfferWei as bigint | undefined) ?? 0n)}</strong>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Offers (no listing required)</h2>
        <label htmlFor="oe">ETH to add to your offer</label>
        <input id="oe" value={offerEth} onChange={(e) => setOfferEth(e.target.value)} />
        <button
          type="button"
          className="primary"
          disabled={!isConnected || !readsEnabled || writePending || wrongChain}
          onClick={() =>
            run(async () => {
              if (!address || !readsEnabled || tokenId === null || !marketplace || !collection) return;
              await writeContractAsync({
                address: marketplace,
                abi: feeRightsFixedSaleAbi,
                functionName: "placeOffer",
                args: [collection, tokenId],
                value: parseEther(offerEth),
                chainId: baseSepolia.id,
              });
            })
          }
        >
          Place / top up offer
        </button>
        <button
          type="button"
          style={{ marginLeft: "0.5rem" }}
          disabled={!isConnected || !readsEnabled || writePending || wrongChain}
          onClick={() =>
            run(async () => {
              if (!readsEnabled || tokenId === null || !marketplace || !collection) return;
              await writeContractAsync({
                address: marketplace,
                abi: feeRightsFixedSaleAbi,
                functionName: "withdrawOffer",
                args: [collection, tokenId],
                chainId: baseSepolia.id,
              });
            })
          }
        >
          Withdraw my offer
        </button>
      </div>

      <div className="panel">
        <h2>Seller — accept a bid</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          You must approve the marketplace on the receipt NFT first (button below), then accept. ETH goes to the
          current owner of the token.
        </p>
        <label htmlFor="bidder">Bidder address to accept</label>
        <input
          id="bidder"
          placeholder="0x…"
          value={acceptBidder}
          onChange={(e) => setAcceptBidder(e.target.value)}
        />
        <button
          type="button"
          className="primary"
          disabled={
            !isConnected || !readsEnabled || !isAddress(acceptBidder) || writePending || wrongChain
          }
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
                chainId: baseSepolia.id,
              });
            })
          }
        >
          Accept offer
        </button>
      </div>

      <div className="panel">
        <h2>NFT approval (list or accept)</h2>
        <button
          type="button"
          disabled={!isConnected || !readsEnabled || writePending || wrongChain}
          onClick={() =>
            run(async () => {
              if (!readsEnabled || !collection || !marketplace) return;
              await writeContractAsync({
                address: collection,
                abi: erc721Abi,
                functionName: "setApprovalForAll",
                args: [marketplace, true],
                chainId: baseSepolia.id,
              });
            })
          }
        >
          Approve marketplace on collection
        </button>
      </div>

      <div className="panel">
        <h2>Fixed listing</h2>
        <label htmlFor="lp">List price (ETH)</label>
        <input id="lp" value={listPriceEth} onChange={(e) => setListPriceEth(e.target.value)} />
        <button
          type="button"
          className="primary"
          disabled={!isConnected || !readsEnabled || writePending || wrongChain}
          onClick={() =>
            run(async () => {
              if (!readsEnabled || tokenId === null || !marketplace || !collection) return;
              await writeContractAsync({
                address: marketplace,
                abi: feeRightsFixedSaleAbi,
                functionName: "list",
                args: [collection, tokenId, parseEther(listPriceEth)],
                chainId: baseSepolia.id,
              });
            })
          }
        >
          List token
        </button>
        <label htmlFor="lid" style={{ marginTop: "1rem" }}>
          Listing ID — cancel
        </label>
        <input id="lid" value={listingIdStr} onChange={(e) => setListingIdStr(e.target.value)} />
        <button
          type="button"
          disabled={!isConnected || !marketplaceOk || writePending || wrongChain}
          onClick={() =>
            run(async () => {
              if (!marketplace) return;
              await writeContractAsync({
                address: marketplace,
                abi: feeRightsFixedSaleAbi,
                functionName: "cancel",
                args: [BigInt(listingIdStr || "0")],
                chainId: baseSepolia.id,
              });
            })
          }
        >
          Cancel listing
        </button>
      </div>

      <div className="panel">
        <h2>Buy listing</h2>
        <label htmlFor="lid2">Listing ID</label>
        <input id="lid2" value={listingIdStr} onChange={(e) => setListingIdStr(e.target.value)} />
        <label htmlFor="bpe">Exact ETH (must match list price)</label>
        <input id="bpe" value={buyPriceEth} onChange={(e) => setBuyPriceEth(e.target.value)} />
        <button
          type="button"
          className="primary"
          disabled={!isConnected || !marketplaceOk || writePending || wrongChain}
          onClick={() =>
            run(async () => {
              if (!marketplace) return;
              await writeContractAsync({
                address: marketplace,
                abi: feeRightsFixedSaleAbi,
                functionName: "buy",
                args: [BigInt(listingIdStr || "0")],
                value: parseEther(buyPriceEth),
                chainId: baseSepolia.id,
              });
            })
          }
        >
          Buy
        </button>
      </div>

      {writeError && <p className="err">{writeError.message}</p>}

      <p className="muted" style={{ marginTop: "2rem" }}>
        Escrow prepare / finalize / redeem still happen in <span className="mono">BankrEscrowV3</span> — this UI only
        covers the marketplace contract.
      </p>
    </>
  );
}
