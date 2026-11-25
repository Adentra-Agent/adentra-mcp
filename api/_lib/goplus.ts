// GoPlus Security API — free, no API key.
// https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses={addr}
// Covers honeypot flags, real buy/sell tax, owner powers, holders and creator.
// Supported here: 1 (Ethereum), 8453 (Base), 42161 (Arbitrum), 4663 (Robinhood).

export interface GoPlusHolder {
  address: string;
  percent: string;
  is_locked: number;
  is_contract: number;
  tag: string;
  balance: string;
}

export interface GoPlusDex {
  name: string;
  liquidity: string;
  liquidity_type: string;
  pair: string;
}

export interface GoPlusToken {
  buy_tax: string;
  sell_tax: string;
  cannot_buy: string;
  cannot_sell_all: string;
  is_honeypot: string;
  is_mintable: string;
  is_proxy: string;
  can_take_back_ownership: string;
  hidden_owner: string;
  is_blacklisted: string;
  is_whitelisted: string;
  transfer_pausable: string;
  trading_cooldown: string;
  selfdestruct: string;
  owner_address: string;
  owner_percent: string;
  creator_address: string;
  creator_balance: string;
  creator_percent: string;
  holder_count: string;
  holders: GoPlusHolder[];
  lp_holder_count: string;
  is_open_source: string;
  is_in_dex: string;
  dex: GoPlusDex[];
  trust_list: string;
}

const SUPPORTED = new Set([1, 8453, 42161, 4663]);

export async function fetchGoPlus(
  token: string,
  chainId: number
): Promise<GoPlusToken | null> {
  if (!SUPPORTED.has(chainId)) return null;
  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${token.toLowerCase()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: number;
      result?: Record<string, GoPlusToken>;
    };
    if (json.code !== 1 || !json.result) return null;
    const entry = json.result[token.toLowerCase()];
    if (!entry) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Batch quick check for radar: one call, many tokens. Returns map address -> token. */
export async function fetchGoPlusBatch(
  tokens: string[],
  chainId: number
): Promise<Record<string, GoPlusToken>> {
  if (!SUPPORTED.has(chainId) || tokens.length === 0) return {};
  try {
    const list = tokens.slice(0, 50).map((t) => t.toLowerCase()).join(',');
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${list}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return {};
    const json = (await res.json()) as {
      code?: number;
      result?: Record<string, GoPlusToken>;
    };
    if (json.code !== 1 || !json.result) return {};
    return json.result;
  } catch {
    return {};
  }
}
