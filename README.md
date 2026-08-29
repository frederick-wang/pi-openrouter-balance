# pi-openrouter-balance

English | [简体中文](./README.zh-CN.md)

> **Unofficial.** Not affiliated with OpenRouter. Reads the OpenRouter API with pi's own credential (`/api/v1/key` + `/api/v1/credits`); those endpoints are not a documented public contract and may change without notice. The package may stop working at any time.

OpenRouter account balance and key usage in the
[pi coding agent](https://github.com/earendil-works/pi-mono) footer, with a full `/openrouter-balance` report.

```
openrouter $149.70 ↓$0.42/h
openrouter $60.00 ███████░ 68% $6.80/$20 ↓$0.42/h   ← per-key limit set
```

## Install

```bash
pi install npm:pi-openrouter-balance
```

Or from git:

```bash
pi install git:github.com/frederick-wang/pi-openrouter-balance
```

Requires an OpenRouter login in pi (`/login` and pick OpenRouter, or `OPENROUTER_API_KEY`).

## Usage

### Footer

Appears when the active model's provider is `openrouter`. Cleared on any other provider.

| Element | Meaning |
| --- | --- |
| `$149.70` | account balance: purchased credits − used credits (may be negative; a negative balance is 402 risk) |
| `$60.00` | same, when the key has a per-key credit limit and the bar takes over the middle of the line |
| `███████░` | 8-cell remaining bar, shown **only when the key has a credit limit** (remaining/limit); no limit → no bar, nothing is invented |
| `68%` | remaining percent of the per-key limit |
| `$6.80/$20` | remaining amount / limit amount for that key |
| `↓$0.42/h` | burn rate. Modes via `/openrouter-balance rate-mode` (or `PI_OPENROUTER_BALANCE_RATE_MODE`, default `this key`): `↓$0.01/h (this key)` — this key's own consumption (all callers of it); `↓$0.44/h (account)` — the whole account (all keys + web); `both`; `hidden`. Estimated from the balance history (≥3 samples spanning ≥1 h, top-ups start a new window) |
| `~` | prefix: last refresh failed, previous numbers kept (marked stale, never presented as current) |
| `·免费` / `·free` | the active model id ends with `:free` (free-model status comes from the model, not the key) |
| color | bar: green ≥ 50% remaining, yellow 20–49%, red < 20% |

State strings replace the whole line when applicable:

| State | Meaning |
| --- | --- |
| `n/a` | loading or no data yet |
| `认证错误` / `auth error` | the credential was rejected (re-resolved once first) |
| `限流中` / `rate limited` | OpenRouter answered 429; a retry is scheduled |
| `额度用尽` / `no credits left` | a 402 came from a real request (or the credits endpoint); polling continues |

### Alerts

One toast per transition:

| Trigger | Copy (EN) |
| --- | --- |
| balance ≤ `PI_OPENROUTER_BALANCE_WARN` (default $20) | `OpenRouter balance $18.20 is below $20.` |
| balance ≤ `PI_OPENROUTER_BALANCE_ERROR` (default $5) | `OpenRouter balance $4.10 is below $5.` |
| same thresholds against the key's remaining limit, when capped | `OpenRouter remaining limit $6.80 is below $20.` |
| 402 from any request (or the credits endpoint) | `OpenRouter no credits left.` |

Recovery re-arms the thresholds (a rise above the previous value, epsilon-tolerant); nothing is ever called a top-up. Free accounts (never purchased) get no low-balance alerts — the thresholds exist to protect a wallet, and a zero wallet is expected there. 402 stays unconditional.

### `/openrouter-balance`

Report overlay, all sections:

| Section | Meaning |
| --- | --- |
| 账户余额 / Account balance | purchased − used for the account; the detail line shows both numbers |
| 额度上限 / Credit limit | per-key cap: remaining bar + percent + remaining/limit + reset cadence (`daily`/`weekly`/`monthly`, opaque if new); `未设置（不限额）` when unlimited; never a invented 0% bar |
| 密钥标签 / Key label | the server's key label (its own masked form) plus 付费账户（已购买额度）/ 免费账户（从未购买额度） |
| 今日/本周/本月 (UTC) | period spends, server-computed; week starts Monday; UTC is labelled because “today” flips at 08:00 Beijing |
| 自带密钥（BYOK） | spend from your own upstream keys; shown only when nonzero |
| 账户消耗速率 / Account burn rate | credits/hour over the whole account (all keys + web); the wallet number next to it |
| 密钥消耗速率 / Key burn rate | credits/hour attributed to THIS key (all clients using it; needs the same gates + $0.01 floor); never implied to be pi-only |
| 余额可用时长 / Runway | balance ÷ rate; shown only when both exist |
| 模型状态 / Model | only when the active model id ends with `:free`: free-model caps (20 req/min · 50 req/day) are stated only for free accounts; paid accounts get the status without cap numbers |
| 数据行 | freshness age + source; `(~)` marks stale |

`/openrouter-balance --json` prints a stable schema (English keys; no credentials, no fingerprints) — TUI overlay or print mode stdout; RPC refuses.

`/openrouter-balance --refresh` bypasses the throttle.

The command works while another provider is selected; it does not turn the footer on.

### Refresh

Fetches on activation and on `/openrouter-balance`; after each settled turn at most every 60 s; a 5-minute heartbeat while an openrouter model is active; 429 honors `Retry-After` with one scheduled retry; 401/403 re-resolves the credential once. If `/credits` is denied (the server may enforce the documented management-key rule later), the extension degrades to key-scoped data with one explanatory line — transient failures keep the last-good balance.

## Auth & privacy

- Credentials resolve through pi's own `openrouter` auth only (env key or OAuth-derived key); the extension never reads or writes credential files.
- Keys/tokens live in memory for the request and are redacted from errors.
- Snapshots persisted to `~/.pi/agent/pi-openrouter-balance-snapshots.jsonl` hold numbers keyed by an HMAC fingerprint of the OpenRouter user id — never the key, never the raw id.
- No telemetry; no network other than the two read endpoints.

## Configuration

- `PI_OPENROUTER_BALANCE_LANG=zh|en` — UI language (default: locale, then English).
- `PI_OPENROUTER_BALANCE_WARN` — low-balance warning threshold in USD (default 20).
- `PI_OPENROUTER_BALANCE_ERROR` — low-balance error threshold in USD (default 5).
- `PI_OPENROUTER_BALANCE_RATE_MODE=key|account|both|hidden` — which rate the footer shows (default `key`; the report always shows both). `/openrouter-balance rate-mode` persists the same choice to `~/.pi/agent/pi-openrouter-balance-prefs.json`; the env var takes precedence and the command says so when it does.
- `PI_CODING_AGENT_DIR` — pi config dir (snapshot location) follows pi's own convention.

## Notes

- Burn rate needs at least three balance samples over an hour; it appears once it can be computed honestly.
- Bars are drawn only for a per-key limit; with no limit the footer shows numbers, not an invented ratio.
- Key `usage` counters are per-key (a fresh key reports 0 while the account keeps spending) — they are displayed, never used for rates.
