import { config } from 'dotenv';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';

config({ quiet: true });

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
const feeManager = process.env.FEE_MANAGER as Address | undefined;
const poolId = process.env.POOL_ID as Hex | undefined;
const seller = process.env.SELLER as Address | undefined;

if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL is not set');
if (!feeManager) throw new Error('FEE_MANAGER is not set');
if (!poolId) throw new Error('POOL_ID is not set');
if (!seller) throw new Error('SELLER is not set');

const bankrFeeManagerAbi = [
  {
    type: 'function',
    name: 'getShares',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'beneficiary', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getCumulatedFees0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'fees0', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getCumulatedFees1',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'fees1', type: 'uint256' }],
  },
] as const;

async function main() {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  console.log('Probing fee manager');
  console.log('Fee manager:', feeManager);
  console.log('Pool ID:', poolId);
  console.log('Seller:', seller);

  const [shares, cumulatedFees0, cumulatedFees1] = await Promise.all([
    publicClient.readContract({
      address: feeManager,
      abi: bankrFeeManagerAbi,
      functionName: 'getShares',
      args: [poolId, seller],
    }),
    publicClient.readContract({
      address: feeManager,
      abi: bankrFeeManagerAbi,
      functionName: 'getCumulatedFees0',
      args: [poolId],
    }),
    publicClient.readContract({
      address: feeManager,
      abi: bankrFeeManagerAbi,
      functionName: 'getCumulatedFees1',
      args: [poolId],
    }),
  ]);

  console.log('Shares:', shares.toString());
  console.log('Cumulated fees0:', cumulatedFees0.toString());
  console.log('Cumulated fees1:', cumulatedFees1.toString());
}

main().catch((error) => {
  console.error('Fee manager probe failed');
  console.error(error);
  process.exit(1);
});
