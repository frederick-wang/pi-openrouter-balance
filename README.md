# pi-openrouter-balance

English | [简体中文](./README.zh-CN.md)

> **Unofficial.** Not affiliated with OpenRouter. Reads the OpenRouter API with pi's own credential (`/api/v1/key` + `/api/v1/credits`); those endpoints are not a documented public contract and may change without notice. The package may stop working at any time.

OpenRouter account balance and key usage in the
[pi coding agent](https://github.com/earendil-works/pi-mono) footer, with a full `/openrouter-balance` report.

```
openrouter $149.70 ↓$0.42/h
openrouter $60.00 ███████░ 68% $6.80/$20 ↓$0.42/h   ← per-key limit set
```

## What it shows

While an `openrouter` model is active: account balance (purchased − used), a per-key credit limit bar (remaining/limit; no bar when the key is unlimited — nothing is invented), period spends (today/week/month, UTC-labelled), BYOK split when nonzero, free-account vs paid-account status, free-model note when the active model id ends with `:free`, burn rate estimated from balance history, and a runway estimate when both exist. Alerts: balance below $20/$5 (env-overridable), same thresholds for a capped key's remaining limit, and an unconditional toast when OpenRouter answers 402.

## Install

```bash
pi install npm:pi-openrouter-balance
```

Or from git:

```bash
pi install git:github.com/frederick-wang/pi-openrouter-balance
```

Requires an OpenRouter login in pi (`/login` and pick OpenRouter, or `OPENROUTER_API_KEY`).

## Commands

- `/openrouter-balance` — full report overlay (all sections listed above).
- `/openrouter-balance --json` — stable machine-readable snapshot (English keys only; no credentials or fingerprints). TUI shows it in the overlay; `print` mode writes it to stdout; other modes refuse.
- `/openrouter-balance --refresh` — bypass the throttle and fetch immediately.

## Auth & privacy

- Credentials resolve through pi's own `openrouter` auth only (env key or OAuth-derived key); the extension never reads or writes credential files.
- Keys/tokens live in memory for the request and are redacted from errors.
- Snapshots persisted to `~/.pi/agent/pi-openrouter-balance-snapshots.jsonl` hold numbers keyed by an HMAC fingerprint of the OpenRouter user id — never the key, never the raw id.
- No telemetry; no network other than the two read endpoints.

## Configuration

- `PI_OPENROUTER_BALANCE_LANG=zh|en` — UI language (default: locale, then English).
- `PI_OPENROUTER_BALANCE_WARN` — low-balance warning threshold in USD (default 20).
- `PI_OPENROUTER_BALANCE_ERROR` — low-balance error threshold in USD (default 5).
- `PI_CODING_AGENT_DIR` — pi config dir (snapshot location) follows pi's own convention.

## Notes

- If OpenRouter ever stops allowing `/credits` for non-management keys, the extension degrades to key-scoped data with a single explanatory line — never a broken experience.
- Burn rate needs at least three balance samples over an hour; it appears once it can be computed honestly.
- Bars are drawn only for a per-key limit; with no limit the footer shows numbers, not an invented ratio.
