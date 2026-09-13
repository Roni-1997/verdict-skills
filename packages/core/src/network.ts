// Network selection. Testnet is the default while the kit is in development (GOAL.md).

export type Network = 'testnet' | 'mainnet';

export interface NetworkConfig {
  readonly network: Network;
  readonly infoUrl: string;
  readonly exchangeUrl: string;
  /** `hyperliquidChain` field of user-signed actions such as approveBuilderFee. */
  readonly hyperliquidChain: 'Testnet' | 'Mainnet';
  /**
   * `signatureChainId` for user-signed (EIP-712) actions, hex. Arbitrum One on mainnet,
   * Arbitrum Sepolia on testnet, matching what the Verdict app signs with.
   */
  readonly signatureChainId: `0x${string}`;
}

const CONFIGS: Record<Network, NetworkConfig> = {
  testnet: {
    network: 'testnet',
    infoUrl: 'https://api.hyperliquid-testnet.xyz/info',
    exchangeUrl: 'https://api.hyperliquid-testnet.xyz/exchange',
    hyperliquidChain: 'Testnet',
    signatureChainId: '0x66eee',
  },
  mainnet: {
    network: 'mainnet',
    infoUrl: 'https://api.hyperliquid.xyz/info',
    exchangeUrl: 'https://api.hyperliquid.xyz/exchange',
    hyperliquidChain: 'Mainnet',
    signatureChainId: '0xa4b1',
  },
};

export function networkConfig(network: Network): NetworkConfig {
  return CONFIGS[network];
}

export function parseNetwork(value: string | undefined): Network {
  if (value === undefined || value === '' || value === 'testnet') return 'testnet';
  if (value === 'mainnet') return 'mainnet';
  throw new Error(`VERDICT_NETWORK must be "testnet" or "mainnet", got ${JSON.stringify(value)}`);
}
