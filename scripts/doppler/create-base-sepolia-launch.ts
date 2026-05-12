import { config } from 'dotenv';
import {
  CHAIN_IDS,
  DopplerSDK,
  WAD,
  getAddresses,
  type ChainAddresses,
} from '@whetstone-research/doppler-sdk/evm';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

config({ quiet: true });

const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
const shouldExecute = process.env.EXECUTE === '1';
const gasLimit = BigInt(process.env.DOPPLER_GAS_LIMIT ?? '10500000');

if (!privateKey) throw new Error('PRIVATE_KEY is not set');
if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL is not set');

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
] as const;

type CandidateFeeManager = {
  label: string;
  address?: Address;
};

function candidateFeeManagers(addresses: ChainAddresses): CandidateFeeManager[] {
  return [
    { label: 'dopplerHookInitializer', address: addresses.dopplerHookInitializer },
    {
      label: 'rehypeDopplerHookInitializer',
      address: addresses.rehypeDopplerHookInitializer,
    },
    { label: 'v4MulticurveInitializer', address: addresses.v4MulticurveInitializer },
    {
      label: 'v4ScheduledMulticurveInitializer',
      address: addresses.v4ScheduledMulticurveInitializer,
    },
    { label: 'v4DecayMulticurveInitializer', address: addresses.v4DecayMulticurveInitializer },
    { label: 'streamableFeesLocker', address: addresses.streamableFeesLocker },
  ].filter((candidate): candidate is { label: string; address: Address } => {
    return Boolean(candidate.address);
  });
}

async function main() {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
    account,
  });

  const sdk = new DopplerSDK({
    publicClient,
    walletClient,
    chainId: CHAIN_IDS.BASE_SEPOLIA,
  });
  const addresses = getAddresses(CHAIN_IDS.BASE_SEPOLIA);
  const airlockBeneficiary = await sdk.getAirlockBeneficiary(WAD / 10n);
  const timestamp = Math.floor(Date.now() / 1000);

  const beneficiaries = [
    airlockBeneficiary,
    {
      beneficiary: account.address,
      shares: WAD - airlockBeneficiary.shares,
    },
  ];

  const params = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      type: 'standard',
      name: `Fee Rights Test ${timestamp}`,
      symbol: `FRT${String(timestamp).slice(-4)}`,
      tokenURI: 'ipfs://fee-rights-test-token',
    })
    .saleConfig({
      initialSupply: 1_000_000n * WAD,
      numTokensToSell: 900_000n * WAD,
      numeraire: addresses.weth,
    })
    .poolConfig({
      fee: 3000,
      tickSpacing: 8,
      curves: [0, 16_000].map((tickLower) => ({
        tickLower,
        tickUpper: 240_000,
        numPositions: 2,
        shares: WAD / 2n,
      })),
      beneficiaries,
    })
    .withGovernance({ type: 'default' })
    .withMigration({ type: 'noOp' })
    .withUserAddress(account.address)
    .withGasLimit(gasLimit)
    .build();

  console.log('Base Sepolia Doppler launch');
  console.log('Execute:', shouldExecute);
  console.log('Deployer / seller:', account.address);
  console.log('WETH:', addresses.weth);
  console.log('Airlock beneficiary:', airlockBeneficiary.beneficiary);
  console.log('Creator beneficiary:', account.address);
  console.log('Gas limit:', gasLimit.toString());
  console.log('Candidate fee managers:');
  for (const candidate of candidateFeeManagers(addresses)) {
    console.log(`  ${candidate.label}: ${candidate.address}`);
  }

  const simulation = await sdk.factory.simulateCreateMulticurve(params);
  console.log('\nSimulation OK');
  console.log('Predicted token:', simulation.tokenAddress);
  console.log('Predicted pool ID:', simulation.poolId);
  console.log('Estimated gas:', simulation.gasEstimate?.toString() ?? 'n/a');

  if (!shouldExecute) {
    console.log('\nSkipping broadcast. Run `npm run doppler:execute` to create the launch.');
    return;
  }

  const result = await simulation.execute();
  console.log('\nCreated Doppler launch');
  console.log('Token address:', result.tokenAddress);
  console.log('Pool ID:', result.poolId);
  console.log('Transaction:', result.transactionHash);

  console.log('\nProbing candidate fee managers with getShares(poolId, seller)');
  for (const candidate of candidateFeeManagers(addresses)) {
    try {
      const shares = await publicClient.readContract({
        address: candidate.address,
        abi: bankrFeeManagerAbi,
        functionName: 'getShares',
        args: [result.poolId, account.address],
      });
      console.log(`${candidate.label} ${candidate.address}: ${shares.toString()}`);
    } catch (error) {
      console.log(`${candidate.label} ${candidate.address}: unsupported or reverted`);
    }
  }
}

main().catch((error) => {
  console.error('Doppler launch failed');
  console.error(error);
  process.exit(1);
});
