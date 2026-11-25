// DEX Screener public API — free, no API key.
// Deepest-liquidity pair for a token: real liquidity depth, price, volume.

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  priceUsd: string | null;
  liquidityUsd: number | null;
  volumeH24: number | null;
  fdv: number | null;
  marketCap: number | null;
  pairCreatedAt: number | null;
  baseSymbol: string;
  quoteSymbol: string;
}

export async function fetchDeepestPair(
  token: string,
  chainId: number
): Promise<DexPair | null> {
  const fromDex = await fetchDexScreenerPair(token, chainId);
  if (fromDex) return fromDex;
  // DEX Screener does not list Robinhood Chain (and sometimes misses a
  // token elsewhere) — GeckoTerminal covers it. Deepest pool whose base
  // token is the scanned token, so the price belongs to this token.
  return fetchGeckoTerminalPair(token, chainId);
}

async function fetchDexScreenerPair(
  token: string,
  chainId: number
): Promise<DexPair | null> {
  // DEX Screener chain slugs: base / ethereum / arbitrum. Robinhood Chain
  // is not listed there yet, so no pair data for 4663.
  const slug = chainId === 8453 ? 'base' : chainId === 1 ? 'ethereum' : chainId === 42161 ? 'arbitrum' : null;
  if (!slug) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.toLowerCase()}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { pairs?: Array<Record<string, unknown>> };
    const pairs = (json.pairs || []).filter(
      (p) => String(p.chainId || '').toLowerCase() === slug
    );
    if (pairs.length === 0) return null;
    pairs.sort((a, b) => {
      const la = Number((a.liquidity as Record<string, unknown> | undefined)?.usd || 0);
      const lb = Number((b.liquidity as Record<string, unknown> | undefined)?.usd || 0);
      return lb - la;
    });
    const p = pairs[0];
    const liq = p.liquidity as Record<string, unknown> | undefined;
    const vol = p.volume as Record<string, unknown> | undefined;
    const baseToken = p.baseToken as Record<string, unknown> | undefined;
    const quoteToken = p.quoteToken as Record<string, unknown> | undefined;
    // priceUsd is the price of the pair's base token. Only use it when the
    // scanned token IS the base token, otherwise it prices the other side.
    const isBase = String(baseToken?.address || '').toLowerCase() === token.toLowerCase();
    return {
      chainId: String(p.chainId),
      dexId: String(p.dexId || ''),
      pairAddress: String(p.pairAddress || ''),
      priceUsd: isBase && p.priceUsd ? String(p.priceUsd) : null,
      liquidityUsd: liq?.usd != null ? Number(liq.usd) : null,
      volumeH24: vol?.h24 != null ? Number(vol.h24) : null,
      fdv: p.fdv != null ? Number(p.fdv) : null,
      marketCap: p.marketCap != null ? Number(p.marketCap) : null,
      pairCreatedAt: p.pairCreatedAt != null ? Number(p.pairCreatedAt) : null,
      baseSymbol: String(baseToken?.symbol || ''),
      quoteSymbol: String(quoteToken?.symbol || ''),
    };
  } catch {
    return null;
  }
}

async function fetchGeckoTerminalPair(token: string, chainId: number): Promise<DexPair | null> {
  const slug = chainId === 4663 ? 'robinhood' : chainId === 8453 ? 'base' : chainId === 1 ? 'eth' : chainId === 42161 ? 'arbitrum' : null;
  if (!slug) return null;
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${slug}/tokens/${token.toLowerCase()}?include=top_pools`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { attributes?: { price_usd?: string; fdv_usd?: string; market_cap_usd?: string } };
      included?: Array<{ attributes?: Record<string, unknown> }>;
    };
    const priceUsd = Number(json.data?.attributes?.price_usd || 0);
    if (!priceUsd) return null;
    const pools = (json.included || [])
      .map((p) => p.attributes || {})
      .filter((a) => {
        const basePrice = Number(a.base_token_price_usd || 0);
        return basePrice > 0 && Math.abs(basePrice - priceUsd) / priceUsd < 0.01;
      });
    if (pools.length === 0) return null;
    pools.sort((a, b) => Number(b.reserve_in_usd || 0) - Number(a.reserve_in_usd || 0));
    const p = pools[0];
    const vol = p.volume_usd as Record<string, unknown> | undefined;
    const name = String(p.name || '');
    const [baseSymbol, quoteSymbol] = name.split(' / ');
    return {
      chainId: String(chainId),
      dexId: 'geckoterminal',
      pairAddress: String(p.address || ''),
      priceUsd: String(p.base_token_price_usd),
      liquidityUsd: p.reserve_in_usd != null ? Number(p.reserve_in_usd) : null,
      volumeH24: vol?.h24 != null ? Number(vol.h24) : null,
      fdv: p.fdv_usd != null ? Number(p.fdv_usd) : json.data?.attributes?.fdv_usd != null ? Number(json.data.attributes.fdv_usd) : null,
      marketCap: p.market_cap_usd != null ? Number(p.market_cap_usd) : json.data?.attributes?.market_cap_usd != null ? Number(json.data.attributes.market_cap_usd) : null,
      pairCreatedAt: p.pool_created_at ? Date.parse(String(p.pool_created_at)) : null,
      baseSymbol: baseSymbol || '',
      quoteSymbol: (quoteSymbol || '').split(' ')[0],
    };
  } catch {
    return null;
  }
}
