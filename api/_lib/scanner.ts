import { erc20Abi, formatUnits, toFunctionSelector, type Address } from 'viem';
import { getPublicClient } from './rpc.js';
import { fetchGoPlus, type GoPlusToken } from './goplus.js';
import { fetchDeepestPair, type DexPair } from './dexscreener.js';
import { getSupabaseAdmin } from './supabaseAdmin.js';

// Adentra scoring mirrors NEARL's published model:
// every token starts at 100, each risk found removes points.
//   sell blocked (honeypot)            −100
//   buy blocked / wallet transfers fail −40
//   tax above 10%                       −30
//   owner can mint                      −25
//   owner can blacklist                 −20
//   no Uniswap pool found               −20
//   upgradeable code · owner can change tax · owner can pause
//   trading · very low liquidity · owner holds over 20%  −15 each
//   tax between 2% and 10%              −10
//   has an owner · low liquidity · owner holds 5–20%
//   · owner can set wallet limits       −5 each
// Owner powers count only while ownership is live: renounced ownership
// locks every admin function (0 penalty). The owner's real wallet balance
// (onchain) drives the owner-holds findings; GoPlus share is the fallback.
// Caps: no sell test → max 70 (except well-known tokens); a token posing
// as a Robinhood stock token → max 40.
// Verdicts: 80–100 Looks safe · 55–79 Be careful · 25–54 High risk · 0–24 Do not buy.

const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
// Beacon embedded in every official Robinhood stock token's bytecode.
const STOCK_BEACON = 'e10b6f6b275de231345c20d14ab812db62151b00';

// Well-known tokens whose sell test may be skipped without capping at 70.
const KNOWN_TOKENS: Record<number, string[]> = {
  4663: ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', '0x0bd7d308f8e1639fab988df18a8011f41eacad73'],
  8453: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x4200000000000000000000000000000000000006'],
  1: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
  42161: ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'],
};

const RISKY: Array<{ key: string; label: string; penalty: number; sigs: string[] }> = [
  { key: 'mint', label: 'can create new tokens (mint)', penalty: 25, sigs: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)'] },
  { key: 'blacklist', label: 'can block wallets from selling (blacklist)', penalty: 20, sigs: ['blacklist(address)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'blacklistAddress(address,bool)', 'addBot(address)', 'setBots(address[],bool)', 'addBots(address[])', 'setBot(address,bool)'] },
  { key: 'fees', label: 'can change buy/sell taxes', penalty: 15, sigs: ['setFee(uint256)', 'setFees(uint256,uint256)', 'setTaxFee(uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)', 'setTax(uint256)', 'setBuyTax(uint256)', 'setSellTax(uint256)', 'setTaxes(uint256,uint256)', 'updateFees(uint256,uint256)', 'updateBuyFees(uint256,uint256,uint256)', 'updateSellFees(uint256,uint256,uint256)'] },
  { key: 'trading', label: 'can pause or switch off trading', penalty: 15, sigs: ['pause()', 'enableTrading()', 'openTrading()', 'setTradingEnabled(bool)', 'setTrading(bool)', 'tradingStatus(bool)'] },
  { key: 'limits', label: 'can limit how much a wallet buys or holds', penalty: 5, sigs: ['setMaxTxAmount(uint256)', 'setMaxWallet(uint256)', 'setMaxWalletSize(uint256)', 'updateMaxTxnAmount(uint256)', 'updateMaxWalletAmount(uint256)', 'setMaxTx(uint256)'] },
];

/** Every PUSH4 operand in the bytecode — function selectors live there. */
function pushedSelectors(codeHex: string): Set<string> {
  const hex = codeHex.startsWith('0x') ? codeHex.slice(2) : codeHex;
  const out = new Set<string>();
  for (let i = 0; i < hex.length; ) {
    const op = parseInt(hex.substr(i, 2), 16);
    i += 2;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4) out.add(hex.substr(i, 8).toLowerCase());
      i += n * 2;
    }
  }
  return out;
}

const OWNER_ABI = [
  { inputs: [], name: 'owner', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'getOwner', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
] as const;

const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as const;

export interface Finding {
  level: 'bad' | 'warn' | 'info' | 'ok';
  title: string;
  detail: string;
  penalty: number;
}

export interface ScanResult {
  chainId: number;
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: string;
  score: number;
  verdict: 'Looks safe' | 'Be careful' | 'High risk' | 'Do not buy';
  safeToBuy: boolean;
  upgradeable: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
  honeypot: boolean;
  liquidityUsd: number | null;
  holderCount: number | null;
  top10Pct: number | null;
  creatorPct: number | null;
  priceUsd: string | null;
  marketCapUsd: number | null;
  stockToken: { official: boolean; symbol?: string; impersonates?: string; officialAddress?: string } | null;
  findings: Finding[];
  launchData: Array<{ k: string; v: string; c: string }>;
  holdersData: Array<{ k: string; v: string; c: string }>;
  tradeSim: Array<{ k: string; v: string; c: string }>;
}

function num(v: string | undefined | null, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const LEVEL_ORDER: Record<Finding['level'], number> = { bad: 0, warn: 1, info: 2, ok: 3 };

export async function runOnchainScan(token: Address, chainId = 8453): Promise<ScanResult> {
  const client = getPublicClient(chainId);

  const [bytecode, implSlot, beaconSlot, name, symbol, decimals, supply, goplus, pair, ownerRaw] = await Promise.all([
    client.getCode({ address: token }),
    client.getStorageAt({ address: token, slot: EIP1967_IMPL_SLOT }).catch(() => '0x0'),
    client.getStorageAt({ address: token, slot: EIP1967_BEACON_SLOT }).catch(() => '0x0'),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }).catch(() => 'Unknown Token'),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' }).catch(() => 0n),
    fetchGoPlus(token, chainId),
    fetchDeepestPair(token, chainId),
    client.readContract({ address: token, abi: OWNER_ABI, functionName: 'owner' })
      .catch(() => client.readContract({ address: token, abi: OWNER_ABI, functionName: 'getOwner' }).catch(() => null)),
  ]);

  const code = (bytecode || '0x').toLowerCase();
  if (code === '0x' || code.length < 4) {
    throw new Error('No contract bytecode found at this address on the selected chain.');
  }

  const findings: Finding[] = [];
  const add = (level: Finding['level'], title: string, detail: string, penalty = 0) =>
    findings.push({ level, title, detail, penalty });

  const slotToAddr = (v: string | null | undefined): Address | null => {
    if (!v || v === '0x' || /^0x0+$/.test(v)) return null;
    return `0x${v.slice(-40)}` as Address;
  };
  const implAddr = slotToAddr(implSlot);
  const beaconAddr = slotToAddr(beaconSlot);
  const upgradeable = Boolean(implAddr || beaconAddr);
  // For proxies, scan the implementation code too (its selectors are the token's real powers).
  let scanCode = code;
  if (implAddr) {
    const implCode = await client.getCode({ address: implAddr }).catch(() => '0x');
    if (implCode) scanCode += (implCode as string).toLowerCase();
  }
  const sels = pushedSelectors(scanCode);
  const hasSelector = (sig: string) => sels.has(toFunctionSelector(sig).slice(2).toLowerCase());

  // ---- Proxy ----
  if (upgradeable) {
    add('warn', 'Upgradeable code', 'The team can replace the token code later. That is common for big projects, but it means the rules can change after you buy.', 15);
  } else {
    add('ok', 'Code cannot be swapped', 'This is not an upgradeable proxy, so the token rules are fixed.');
  }

  // ---- Owner powers, NEARL model: renounced ownership locks every admin function ----
  const owner = ownerRaw as Address | null;
  const renounced = !owner || owner === '0x0000000000000000000000000000000000000000' || owner.toLowerCase() === '0x000000000000000000000000000000000000dead';
  const powers = RISKY.filter((g) => g.sigs.some((s) => hasSelector(s)));
  if (renounced) {
    add('ok', owner ? 'Ownership renounced' : 'No owner found', 'Nobody holds special admin rights over this token.');
    if (powers.length) add('info', 'Admin functions exist but are locked', 'The code has admin functions, but with no owner nobody can call them.');
  } else {
    add('info', 'Has an owner', `Owner wallet ${owner.slice(0, 6)}…${owner.slice(-4)} can call admin functions.`, 5);
    for (const g of powers) {
      add(g.penalty >= 20 ? 'bad' : 'warn', `Owner ${g.label}`, 'Found in the contract code. Check that the team is trustworthy before buying.', g.penalty);
    }
    if (!powers.length) add('ok', 'No risky admin functions found', 'No mint, blacklist, tax or trading switch functions were found in the code.');
  }

  // ---- GoPlus: honeypot, real taxes, extra owner flags ----
  const gp: GoPlusToken | null = goplus;
  const honeypot = gp ? gp.is_honeypot === '1' || gp.cannot_sell_all === '1' : false;
  const buyTax = gp ? num(gp.buy_tax) : 0;
  const sellTax = gp ? num(gp.sell_tax) : 0;
  const holderCount = gp?.holder_count ? num(gp.holder_count) : null;
  const creatorPct = gp?.creator_percent != null ? num(gp.creator_percent) : null;
  const ownerPct = gp?.owner_percent != null ? num(gp.owner_percent) : null;
  const top10Pct = gp?.holders?.length
    ? gp.holders.slice(0, 10).reduce((acc, h) => acc + num(h.percent), 0)
    : null;
  const sellTested = Boolean(gp); // GoPlus honeypot fields are the sell test here

  if (gp) {
    if (gp.cannot_buy === '1') {
      add('bad', 'Buying looks blocked', 'A simulated buy failed — the token cannot be bought right now.', 40);
    }
    if (honeypot) {
      add('bad', 'Selling looks blocked (possible honeypot)', 'A simulated sell failed. You may be able to buy but never sell.', 100);
    }
    const worstTax = Math.max(buyTax, sellTax);
    if (worstTax > 10) {
      add('bad', `High tax: ${worstTax.toFixed(1)}%`, 'You lose this share of tokens on each trade.', 30);
    } else if (worstTax > 2) {
      add('warn', `Tax: ${worstTax.toFixed(1)}%`, 'Part of each trade is taken as a fee.', 10);
    } else if (buyTax > 0 || sellTax > 0) {
      add('ok', `Simulated buy and sell work`, `The test went through with a ${worstTax.toFixed(1)}% tax.`);
    } else {
      add('ok', 'Simulated buy and sell work', 'The test went through with no tax.');
    }
    // GoPlus is used only for what the bytecode cannot say: honeypot and
    // real taxes. Owner powers come from the bytecode scan above, exactly
    // like NEARL — GoPlus flags do not add penalties here.
  } else {
    add('info', 'Sell test not possible', 'The security feed did not answer for this token, so the honeypot test was skipped.');
  }

  // ---- Holders: the owner's real wallet balance, GoPlus share as fallback ----
  let holderShare: number | null = null;
  if (owner && !renounced && supply > 0n) {
    const ob = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }).catch(() => null);
    if (ob != null) holderShare = Number((ob * 10000n) / supply) / 100;
  }
  if (holderShare == null) holderShare = ownerPct != null ? ownerPct : creatorPct;
  if (holderShare != null) {
    if (holderShare > 20) {
      add('bad', `Owner holds ${holderShare.toFixed(1)}% of supply`, 'One wallet could sell a large amount at once and crash the price.', 15);
    } else if (holderShare >= 5) {
      add('warn', `Owner holds ${holderShare.toFixed(1)}% of supply`, 'A noticeable share sits with the owner.', 5);
    }
  }
  if (top10Pct != null && top10Pct > 50) {
    add('warn', `Top 10 holders control ${top10Pct.toFixed(1)}%`, 'A small group could move the price together.', 0);
  }

  // ---- Liquidity (deepest pool) ----
  const dex: DexPair | null = pair;
  const liquidityUsd = dex?.liquidityUsd ?? null;
  const priceUsd = dex?.priceUsd ?? null;
  if (dex && liquidityUsd != null) {
    if (liquidityUsd < 1_000) {
      add('warn', 'Very low liquidity', `The deepest pool holds only $${Math.round(liquidityUsd).toLocaleString('en-US')}.`, 15);
    } else if (liquidityUsd < 100_000) {
      add('info', 'Low liquidity', `The deepest pool holds $${Math.round(liquidityUsd).toLocaleString('en-US')}.`, 5);
    } else {
      add('ok', 'Liquidity found', `Deepest pool: $${Math.round(liquidityUsd).toLocaleString('en-US')}.`);
    }
  } else {
    add('bad', 'No Uniswap pool found', 'No pool was found for this token, so it cannot be traded or priced.', 20);
  }

  // ---- Robinhood stock tokens (chain 4663) ----
  let stockToken: ScanResult['stockToken'] = null;
  if (chainId === 4663) {
    const runsStockCode = code.includes(STOCK_BEACON);
    const sb = getSupabaseAdmin();
    const { data: row } = sb
      ? await sb.from('stock_tokens').select('ticker, name').eq('token_address', token.toLowerCase()).maybeSingle()
      : { data: null };
    if (row) {
      stockToken = { official: true, symbol: row.ticker as string };
      const company = (row.name as string).split(' • ')[0];
      add('ok', `Official Robinhood stock token: ${company} (${row.ticker})`, 'Created by Robinhood’s StockFactory. It follows the share price; Robinhood describes stock tokens as not giving ownership of the share itself. Upgrades, minting and freezing are normal for the issuer.');
    } else if (runsStockCode) {
      add('warn', 'Robinhood stock-token code, not confirmed official', 'This token runs on the same code as Robinhood’s stock tokens, but Adentra could not confirm that Robinhood’s StockFactory created it.', 10);
    } else {
      // Impersonation / lookalike / same-ticker checks against the registry.
      const sym = String(symbol).toUpperCase();
      const nm = String(name);
      const { data: match } = sb
        ? await sb.from('stock_tokens').select('ticker, name, token_address').eq('ticker', sym).maybeSingle()
        : { data: null };
      if (match) {
        const company = (match.name as string).split(' • ')[0];
        const claimsName = nm.toLowerCase().includes(company.toLowerCase());
        stockToken = { official: false, impersonates: sym, officialAddress: match.token_address as string };
        if (claimsName) {
          add('bad', `Not the official ${sym} stock token`, `It uses the name of Robinhood’s ${company} stock token, but it was not created by Robinhood. The official ${sym} token is ${match.token_address}.`, 40);
        } else if (nm.toLowerCase().includes(company.toLowerCase().slice(0, 4))) {
          add('warn', `Looks like the ${sym} stock token, but is not`, `It has the same ticker as Robinhood’s ${company} stock token and a similar name, but Robinhood did not create it. The official ${sym} token is ${match.token_address}.`, 10);
        } else {
          add('info', `Same ticker as Robinhood’s ${sym} stock token`, `This is not the ${company} stock token. If that is what you wanted, the official one is ${match.token_address}.`);
        }
      } else if (/robinhood/i.test(nm)) {
        add('bad', 'Claims to be a Robinhood token, but is not', 'Its name says Robinhood Token, but it was not created by Robinhood’s StockFactory.', 40);
      }
    }
  }

  // ---- Score ----
  let score = Math.max(0, 100 - findings.reduce((a, x) => a + x.penalty, 0));
  const known = (KNOWN_TOKENS[chainId] || []).includes(token.toLowerCase());
  if (!sellTested && !known) score = Math.min(score, 70);
  if (stockToken && !stockToken.official && stockToken.impersonates) score = Math.min(score, 40);
  if (/robinhood/i.test(String(name)) && chainId === 4663 && !stockToken?.official) score = Math.min(score, 40);
  score = Math.max(0, Math.min(100, score));

  const verdict: ScanResult['verdict'] =
    score >= 80 ? 'Looks safe' : score >= 55 ? 'Be careful' : score >= 25 ? 'High risk' : 'Do not buy';
  const safeToBuy = score >= 55;

  findings.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.penalty - a.penalty);
  if (findings.length === 0) {
    add('ok', 'No red flags found', 'No risky owner powers, taxes or honeypot signals were found.');
  }

  const formattedSupply = Number(formatUnits(supply, decimals)).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
  const marketCapUsd = priceUsd != null ? Number(priceUsd) * Number(formatUnits(supply, decimals)) : null;

  const liqLabel =
    liquidityUsd == null
      ? 'NO_PAIR'
      : liquidityUsd >= 1_000_000
        ? `$${(liquidityUsd / 1_000_000).toFixed(2)}M (DEEP)`
        : liquidityUsd >= 10_000
          ? `$${Math.round(liquidityUsd).toLocaleString('en-US')}`
          : `$${Math.round(liquidityUsd).toLocaleString('en-US')} (THIN)`;

  return {
    chainId,
    token: token.toLowerCase(),
    symbol: String(symbol),
    name: String(name),
    decimals: Number(decimals),
    totalSupply: formattedSupply,
    score,
    verdict,
    safeToBuy,
    upgradeable,
    buyTaxPct: buyTax,
    sellTaxPct: sellTax,
    honeypot,
    liquidityUsd,
    holderCount,
    top10Pct,
    creatorPct,
    priceUsd,
    marketCapUsd,
    stockToken,
    findings,
    launchData: [
      { k: 'PROXY_EIP1967', v: upgradeable ? 'UPGRADEABLE' : 'IMMUTABLE', c: upgradeable ? 'text-term-amber' : 'text-emerald-400' },
      { k: 'OFFICIAL_STOCK', v: stockToken?.official ? 'TRUE · ROBINHOOD' : 'NO', c: stockToken?.official ? 'text-emerald-400' : 'text-term-ink' },
      { k: 'BYTECODE_SIZE', v: `${Math.floor((code.length - 2) / 2)} bytes`, c: 'text-term-ink' },
      { k: 'OWNER_POWERS', v: powers.length ? powers.map((g) => g.key).join(', ') : 'NONE', c: powers.length ? 'text-term-amber' : 'text-emerald-400' },
      { k: 'CREATOR_HOLD', v: creatorPct == null ? 'UNKNOWN' : `${creatorPct.toFixed(2)}%`, c: creatorPct != null && creatorPct > 10 ? 'text-red-400' : 'text-term-ink' },
      { k: 'CHAIN_ID', v: String(chainId), c: 'text-term-ink' },
    ],
    holdersData: [
      { k: 'TOTAL_SUPPLY', v: formattedSupply, c: 'text-term-ink' },
      { k: 'DECIMALS', v: String(decimals), c: 'text-term-ink' },
      { k: 'HOLDER_COUNT', v: holderCount == null ? 'UNKNOWN' : holderCount.toLocaleString('en-US'), c: 'text-term-ink' },
      { k: 'TOP10_CONTROL', v: top10Pct == null ? 'UNKNOWN' : `${top10Pct.toFixed(1)}%`, c: top10Pct != null && top10Pct > 50 ? 'text-red-400' : 'text-term-ink' },
      { k: 'LIQUIDITY_USD', v: liqLabel, c: liquidityUsd != null && liquidityUsd < 10_000 ? 'text-term-amber' : 'text-emerald-400' },
      { k: 'SAFE_TO_BUY', v: safeToBuy ? 'TRUE' : 'FALSE', c: safeToBuy ? 'text-emerald-400' : 'text-red-400' },
    ],
    tradeSim: [
      { k: 'SIM_BUY_TAX', v: `${buyTax}%`, c: buyTax > 10 ? 'text-red-400' : buyTax > 0 ? 'text-term-amber' : 'text-emerald-400' },
      { k: 'SIM_SELL_TAX', v: `${sellTax}%`, c: sellTax > 10 ? 'text-red-400' : sellTax > 0 ? 'text-term-amber' : 'text-emerald-400' },
      { k: 'HONEYPOT', v: honeypot ? 'YES — SELL BLOCKED' : 'NO', c: honeypot ? 'text-red-400' : 'text-emerald-400' },
      { k: 'MCP_DECISION', v: score >= 80 ? 'PROCEED' : score >= 55 ? 'CONFIRM' : 'ABORT', c: score >= 80 ? 'text-emerald-400' : score >= 55 ? 'text-term-amber' : 'text-red-400' },
      { k: 'CACHE_TTL', v: '10 MIN', c: 'text-term-muted' },
    ],
  };
}
