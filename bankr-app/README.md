# Bankr app (web)

Minimal Base Sepolia UI for `FeeRightsFixedSale`: connect wallet, read aggregate and personal offers, place / withdraw offers, approve collection, list / cancel / buy, and accept a bid.

## Setup

```bash
cd bankr-app
npm install
```

Copy `.env.example` to `.env` and set deployed addresses when you have them.

```bash
npm run dev
```

Opens on port **5174** by default.

## Build

```bash
npm run build
npm run preview
```

The ABI is checked in under `src/lib/feeRightsFixedSaleAbi.ts`. After changing Solidity, regenerate:

```bash
cd ..   # fee-rights-exchange root
forge build
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('out/FeeRightsFixedSale.sol/FeeRightsFixedSale.json','utf8'));fs.writeFileSync('bankr-app/src/lib/feeRightsFixedSaleAbi.ts','export const feeRightsFixedSaleAbi = '+JSON.stringify(j.abi,null,2)+' as const;\\n');"
```
