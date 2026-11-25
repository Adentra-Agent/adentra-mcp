import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAddress } from 'viem';
import { runOnchainScan } from './_lib/scanner.js';
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js';
import { authorizeTrade } from './_lib/guard.js';

const TOOLS = [
  {
    name: 'adentra_check_token',
    description: 'Scan an EVM ERC-20 token for proxy slots, risky owner selectors, and safety score (0-100).',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: '0x ERC-20 contract address' },
        chainId: { type: 'number', description: 'EVM Chain ID (default 8453 Base)' },
      },
      required: ['token'],
    },
  },
  {
    name: 'adentra_list_radar',
    description: 'List recently detected liquidity pools from Adentra Radar.',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'EVM Chain ID (default 8453)' },
        limit: { type: 'number', description: 'Max items (default 10)' },
      },
    },
  },
  {
    name: 'adentra_check_deployer',
    description: 'Check historical launch reputation for a deployer wallet address.',
    inputSchema: {
      type: 'object',
      properties: {
        deployer: { type: 'string', description: '0x deployer address' },
        chainId: { type: 'number', description: 'EVM Chain ID (default 8453)' },
      },
      required: ['deployer'],
    },
  },
  {
    name: 'adentra_guard_check',
    description: 'Ask the Guard policy engine whether an agent trade is allowed: daily UTC cap, per-trade cap, approved router/recipient, pause state. Returns ALLOW or DENY with the reason; the decision is logged.',
    inputSchema: {
      type: 'object',
      properties: {
        vault: { type: 'string', description: '0x Guard vault address' },
        agent: { type: 'string', description: '0x agent wallet address' },
        token: { type: 'string', description: '0x ERC-20 contract address to buy' },
        amountUsdc: { type: 'number', description: 'Order size in USDC' },
        chainId: { type: 'number', description: 'EVM Chain ID (default 8453 Base)' },
        router: { type: 'string', description: '0x DEX router address (optional)' },
        recipient: { type: 'string', description: '0x recipient address (optional)' },
      },
      required: ['vault', 'agent', 'token', 'amountUsdc'],
    },
  },
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST for JSON-RPC MCP requests' });

  const { id, method, params } = req.body || {};

  if (method === 'initialize') {
    return res.status(200).json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'adentra-mcp', version: '1.0.4' },
      },
    });
  }

  if (method === 'tools/list') {
    return res.status(200).json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      if (toolName === 'adentra_check_token') {
        if (!isAddress(String(args.token || ''))) {
          throw new Error('Invalid token address');
        }
        const scan = await runOnchainScan(args.token, Number(args.chainId || 8453));
        return res.status(200).json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(scan, null, 2) }] },
        });
      }

      if (toolName === 'adentra_list_radar') {
        const sb = getSupabaseAdmin();
        const limit = Math.min(25, Number(args.limit || 10));
        const chainId = Number(args.chainId || 8453);
        const { data } = sb
          ? await sb.from('radar_pools').select('*').eq('chain_id', chainId).order('detected_at', { ascending: false }).limit(limit)
          : { data: [] };
        return res.status(200).json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(data || [], null, 2) }] },
        });
      }

      if (toolName === 'adentra_check_deployer') {
        const sb = getSupabaseAdmin();
        const deployer = String(args.deployer || '').toLowerCase();
        const chainId = Number(args.chainId || 8453);
        const { data } = sb
          ? await sb.from('deployer_reputation').select('*').eq('chain_id', chainId).eq('deployer_address', deployer).maybeSingle()
          : { data: null };
        return res.status(200).json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data || { deployer, status: 'NO_PRIOR_RECORD' }, null, 2) }],
          },
        });
      }

      if (toolName === 'adentra_guard_check') {
        const vault = String(args.vault || '');
        const agent = String(args.agent || '');
        const token = String(args.token || '');
        if (!isAddress(vault) || !isAddress(agent) || !isAddress(token)) {
          throw new Error('vault, agent and token must be valid 0x addresses');
        }
        const amount = Number(args.amountUsdc);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error('amountUsdc must be a positive number');
        }
        const result = await authorizeTrade({
          vaultAddress: vault,
          agentAddress: agent,
          chainId: Number(args.chainId || 8453),
          tokenAddress: token,
          amountUsdc: amount,
          routerAddress: args.router ? String(args.router) : undefined,
          recipientAddress: args.recipient ? String(args.recipient) : undefined,
        });
        if ('error' in result) throw new Error(result.error);
        return res.status(200).json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        });
      }

      return res.status(200).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    } catch (err: unknown) {
      return res.status(200).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : 'Tool error' },
      });
    }
  }

  return res.status(200).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unsupported method: ${method}` },
  });
}
