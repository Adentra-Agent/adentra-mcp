# Adentra skill

Give your agent a second opinion before every buy.

## Rule

Before your agent buys any token, call Adentra's check. Skip the token when
`safeToBuy` is false (score below 55). A token that cannot be sold (possible
honeypot) scores near 0 and must never be bought.

## HTTP API

```
GET https://adentra.xyz/api/check?token=0x…&chainId=8453
```

- `chainId`: 8453 (Base, default), 1 (Ethereum), 42161 (Arbitrum), 4663 (Robinhood Chain).
- Returns JSON: `symbol`, `name`, `score` (0–100), `verdict` ("Looks safe" / "Be careful" / "High risk" / "Do not buy"), `safeToBuy`, `buyTaxPct`, `sellTaxPct`, `liquidityUsd`, `priceUsd`, `marketCapUsd`, `findings` (each with `level`, `title`, `detail`, `penalty`).
- Limit: 20 checks per minute per IP. Results are cached for 10 minutes.

## MCP server

```
{
  "mcpServers": {
    "adentra": {
      "type": "http",
      "url": "https://adentra.xyz/api/mcp"
    }
  }
}
```

Tools:

- `adentra_check_token` — `{ "token": "0x…", "chainId": 8453 }`. Score a token.
- `adentra_list_radar` — new pools with quick red flags.
- `adentra_check_deployer` — a creator's other launches and how they ended.
- `adentra_guard_check` — ask the Guard policy engine before a trade (caps, routers, recipients, pause).

## Guard

When your agent trades through a Guard, every trade must fit the daily and
per-trade limits, go to an approved router and an approved recipient, and
respect a pause. Ask `adentra_guard_check` first; a DENY means do not sign.

## Scoring

Every token starts at 100; each risk removes points. Selling blocked −100,
buying blocked −40, tax above 10% −30, owner can mint −25, blacklist −20,
no pool −20, upgradeable / change tax / pause / very low liquidity / owner
over 20% −15 each, tax 2–10% −10, has owner / low liquidity / owner 5–20%
−5 each. No sell test caps the score at 70. A token posing as an official
Robinhood stock token caps at 40.
