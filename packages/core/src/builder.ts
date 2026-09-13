// Builder codes: status, the one-time approval payload, and unsigned orders that carry the code.
// Nothing here signs. The caller signs approvals with the main wallet and orders with its own key.
import type { InfoClient } from './hl/client.js';
import type { NetworkConfig } from './network.js';
import type { Market } from './markets.js';

export interface BuilderCode {
  /** Verdict's builder address. */
  readonly address: `0x${string}`;
  /** Fee in tenths of a basis point of notional: 10 means 1 basis point. */
  readonly feeTenthsBp: number;
}

/** 1 tenth of a basis point on $1,000 is one cent, so cents per $1,000 equals the fee in tenths of a basis point. */
export function feeCentsPer1000(feeTenthsBp: number): number {
  return feeTenthsBp;
}

/** Hyperliquid expresses approved rates as percent strings: 10 tenths of a basis point is 0.01%. */
export function feeTenthsBpToPercentString(feeTenthsBp: number): string {
  const pct = feeTenthsBp / 1000;
  return `${pct.toString()}%`;
}

export interface BuilderStatus {
  readonly user: string;
  readonly builder: string;
  readonly approvedMaxTenthsBp: number;
  readonly requiredTenthsBp: number;
  readonly approved: boolean;
}

export async function builderStatus(client: InfoClient, user: string, code: BuilderCode): Promise<BuilderStatus> {
  const approvedMaxTenthsBp = await client.maxBuilderFee(user, code.address);
  return {
    user,
    builder: code.address,
    approvedMaxTenthsBp,
    requiredTenthsBp: code.feeTenthsBp,
    approved: approvedMaxTenthsBp >= code.feeTenthsBp,
  };
}

export interface ApproveBuilderFeeAction {
  readonly type: 'approveBuilderFee';
  readonly hyperliquidChain: 'Testnet' | 'Mainnet';
  readonly signatureChainId: `0x${string}`;
  readonly maxFeeRate: string;
  readonly builder: `0x${string}`;
  readonly nonce: number;
}

export interface ApproveBuilderFeePayload {
  readonly action: ApproveBuilderFeeAction;
  /** EIP-712 typed data for the caller's main wallet. Agent keys cannot sign this action. */
  readonly typedData: {
    readonly domain: { name: 'HyperliquidSignTransaction'; version: '1'; chainId: number; verifyingContract: `0x${string}` };
    readonly types: {
      readonly 'HyperliquidTransaction:ApproveBuilderFee': readonly { name: string; type: string }[];
    };
    readonly primaryType: 'HyperliquidTransaction:ApproveBuilderFee';
    readonly message: { hyperliquidChain: string; maxFeeRate: string; builder: `0x${string}`; nonce: number };
  };
  readonly notes: readonly string[];
}

export function approveBuilderFeePayload(config: NetworkConfig, code: BuilderCode, nonceMs: number = Date.now()): ApproveBuilderFeePayload {
  const maxFeeRate = feeTenthsBpToPercentString(code.feeTenthsBp);
  const action: ApproveBuilderFeeAction = {
    type: 'approveBuilderFee',
    hyperliquidChain: config.hyperliquidChain,
    signatureChainId: config.signatureChainId,
    maxFeeRate,
    builder: code.address,
    nonce: nonceMs,
  };
  return {
    action,
    typedData: {
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: Number.parseInt(config.signatureChainId, 16),
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        'HyperliquidTransaction:ApproveBuilderFee': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'maxFeeRate', type: 'string' },
          { name: 'builder', type: 'address' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
      message: { hyperliquidChain: config.hyperliquidChain, maxFeeRate, builder: code.address, nonce: nonceMs },
    },
    notes: [
      'Sign with the main wallet. Hyperliquid rejects agent or API wallet signatures for this action.',
      'A user may hold at most 10 active builder approvals.',
      `This approves at most ${maxFeeRate} (${feeCentsPer1000(code.feeTenthsBp)} cents per $1,000) for builder ${code.address}.`,
    ],
  };
}

export type TimeInForce = 'Gtc' | 'Ioc' | 'Alo';

export interface BuildOrderRequest {
  readonly market: Market;
  readonly side: 0 | 1;
  readonly action: 'buy' | 'sell';
  /** Limit price as a decimal string in quote units per token, e.g. "0.62". */
  readonly price: string;
  /** Size as a decimal string in tokens, e.g. "250". */
  readonly size: string;
  readonly tif?: TimeInForce;
  readonly reduceOnly?: boolean;
  /** Optional client order id, 16-byte hex. */
  readonly cloid?: `0x${string}`;
}

/**
 * The order action exactly as Hyperliquid re-encodes it to validate the signature: msgpack
 * encodes map keys in insertion order, so key order here is part of the hash. Matches the
 * Verdict app's buildOrderAction with `builder` appended after `grouping`.
 */
export interface OrderAction {
  readonly type: 'order';
  readonly orders: readonly {
    readonly a: number;
    readonly b: boolean;
    readonly p: string;
    readonly s: string;
    readonly r: boolean;
    readonly t: { readonly limit: { readonly tif: TimeInForce } };
    readonly c?: `0x${string}`;
  }[];
  readonly grouping: 'na';
  readonly builder: { readonly b: `0x${string}`; readonly f: number };
}

export interface BuiltOrder {
  readonly action: OrderAction;
  readonly market: { outcome: number; venue: string; displayName: string; settlementRule: string | null; expiresAt: string | null };
  readonly side: { index: 0 | 1; name: string; coin: string; assetId: number };
  readonly summary: {
    readonly action: 'buy' | 'sell';
    readonly price: string;
    readonly size: string;
    readonly notional: number;
    readonly maxLossIfWrong: number;
    readonly payoutIfRight: number;
    readonly builderFeeCentsPer1000: number;
    readonly builderFeeEstimate: number;
  };
  readonly confirmation: readonly string[];
}

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

export function canonicalDecimal(value: string, maxDecimals: number): string {
  if (!DECIMAL.test(value)) throw new Error(`invalid decimal string ${JSON.stringify(value)}`);
  const [int, frac = ''] = value.split('.');
  if (frac.length > maxDecimals) throw new Error(`at most ${maxDecimals} decimals allowed, got ${JSON.stringify(value)}`);
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : (int as string);
}

export function buildOrder(req: BuildOrderRequest, code: BuilderCode): BuiltOrder {
  const price = canonicalDecimal(req.price, 5);
  const size = canonicalDecimal(req.size, 0);
  const px = Number(price);
  if (!(px > 0 && px < 1)) throw new Error('outcome prices must be strictly between 0 and 1');
  const sz = Number(size);
  if (!(sz > 0)) throw new Error('size must be positive');
  const side = req.market.sides[req.side];
  const isBuy = req.action === 'buy';
  const order: OrderAction['orders'][number] = {
    a: side.assetId,
    b: isBuy,
    p: price,
    s: size,
    r: req.reduceOnly ?? false,
    t: { limit: { tif: req.tif ?? 'Gtc' } },
    ...(req.cloid ? { c: req.cloid } : {}),
  };
  const action: OrderAction = {
    type: 'order',
    orders: [order],
    grouping: 'na',
    builder: { b: code.address, f: code.feeTenthsBp },
  };
  const notional = px * sz;
  const fee = notional * (code.feeTenthsBp / 100_000);
  return {
    action,
    market: {
      outcome: req.market.outcome,
      venue: req.market.venue,
      displayName: req.market.displayName,
      settlementRule: req.market.settlementRule,
      expiresAt: req.market.expiresAt,
    },
    side: { index: side.index, name: side.name, coin: side.coin, assetId: side.assetId },
    summary: {
      action: req.action,
      price,
      size,
      notional,
      maxLossIfWrong: isBuy ? notional : (1 - px) * sz,
      payoutIfRight: isBuy ? sz : notional,
      builderFeeCentsPer1000: feeCentsPer1000(code.feeTenthsBp),
      builderFeeEstimate: fee,
    },
    confirmation: [
      `${req.action.toUpperCase()} ${size} ${side.name} on ${req.market.displayName} at ${price}`,
      req.market.settlementRule ? `Settles: ${req.market.settlementRule}` : 'Settlement rule: not available for this market',
      `Notional ${notional.toFixed(2)} ${req.market.quoteToken}; builder fee ${feeCentsPer1000(code.feeTenthsBp)} cents per $1,000 to ${code.address}`,
      'This payload is unsigned. Sign it with your own key and submit it yourself. Confirm before signing.',
    ],
  };
}
