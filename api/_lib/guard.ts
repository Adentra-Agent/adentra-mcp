// Guard policy engine (off-chain policy + audit log).
// Mirrors NEARL Guard semantics — daily UTC cap, per-trade cap, approved
// routers/recipients only, withdraw-to-owner, one-click pause — enforced
// here as a policy decision + immutable decision log in Supabase, instead
// of an onchain Guard contract (which needs a deploy + funded vault).
// Agents call this before executing; the swap UI calls it before signing.

import { getSupabaseAdmin } from './supabaseAdmin.js';

export interface AuthorizeInput {
  vaultAddress: string;
  agentAddress: string;
  chainId: number;
  tokenAddress: string;
  amountUsdc: number;
  routerAddress?: string;
  recipientAddress?: string;
}

export interface AuthorizeResult {
  decision: 'ALLOW' | 'DENY';
  reason: string;
  spentTodayUsdc: number;
  remainingDailyUsdc: number | null;
}

function utcMidnightIso(): string {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now.toISOString();
}

export async function authorizeTrade(input: AuthorizeInput): Promise<AuthorizeResult | { error: string }> {
  const sb = getSupabaseAdmin();
  if (!sb) return { error: 'Guard backend not configured (missing Supabase service key)' };

  const vaultAddr = input.vaultAddress.toLowerCase();
  const { data: vault, error } = await sb
    .from('guard_vaults')
    .select('*')
    .eq('vault_address', vaultAddr)
    .maybeSingle();
  if (error || !vault) return { error: 'Guard vault not found' };

  const { data: spentRows } = await sb
    .from('guard_decisions')
    .select('amount_usdc')
    .eq('vault_address', vaultAddr)
    .eq('decision', 'ALLOW')
    .gte('created_at', utcMidnightIso());
  const spentToday = (spentRows || []).reduce((acc, r) => acc + Number(r.amount_usdc || 0), 0);
  const remaining = Math.max(0, Number(vault.daily_cap_usdc) - spentToday);

  let decision: 'ALLOW' | 'DENY' = 'ALLOW';
  let reason = 'PASS: within daily + per-trade caps, router and recipient approved.';
  if (vault.is_paused) {
    decision = 'DENY';
    reason = 'REVERT: Emergency one-click pause is active. All agent execution frozen.';
  } else if (String(vault.agent_address).toLowerCase() !== input.agentAddress.toLowerCase()) {
    decision = 'DENY';
    reason = 'REVERT: Caller is not the vault agent address.';
  } else if (
    input.routerAddress &&
    Array.isArray(vault.approved_routers) &&
    vault.approved_routers.length > 0 &&
    !vault.approved_routers.map((r: string) => r.toLowerCase()).includes(input.routerAddress.toLowerCase())
  ) {
    decision = 'DENY';
    reason = 'REVERT: Target router is not on the owner whitelist.';
  } else if (
    input.recipientAddress &&
    Array.isArray(vault.approved_recipients) &&
    vault.approved_recipients.length > 0 &&
    !vault.approved_recipients.map((r: string) => r.toLowerCase()).includes(input.recipientAddress.toLowerCase())
  ) {
    decision = 'DENY';
    reason = 'REVERT: Recipient is not on the owner whitelist.';
  } else if (input.amountUsdc > Number(vault.per_trade_cap_usdc)) {
    decision = 'DENY';
    reason = `REVERT: Order (${input.amountUsdc} USDC) exceeds per-trade cap (${vault.per_trade_cap_usdc} USDC).`;
  } else if (spentToday + input.amountUsdc > Number(vault.daily_cap_usdc)) {
    decision = 'DENY';
    reason = `REVERT: Order exceeds UTC daily cap (${vault.daily_cap_usdc} USDC, ${remaining.toFixed(2)} USDC remaining).`;
  }

  await sb.from('guard_decisions').insert({
    vault_address: vaultAddr,
    agent_address: input.agentAddress.toLowerCase(),
    chain_id: input.chainId,
    token_address: input.tokenAddress.toLowerCase(),
    amount_usdc: input.amountUsdc,
    decision,
    reason,
  });

  return {
    decision,
    reason,
    spentTodayUsdc: spentToday,
    remainingDailyUsdc: decision === 'ALLOW' ? Math.max(0, remaining - input.amountUsdc) : remaining,
  };
}
