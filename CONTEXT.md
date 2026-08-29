# pi-openrouter-balance

A pi coding agent extension showing OpenRouter account balance and key usage in the agent UI while an `openrouter` provider model is active.

## Language

**Balance**:
The account wallet: total purchased credits minus total usage; may be negative (402 risk). Displayed in USD.
_Avoid_: credits, remaining money, 钱包（UI copy）

**Credit limit**:
An optional per-key spending cap; when unset the key is unlimited and there is no "remaining" to show.
_Avoid_: 额度阈值（口语可，正式文案用 额度上限）

**Remaining (under limit)**:
What the key may still spend before hitting its cap; exists only when a limit is set.
_Avoid_: leftover, 剩余额度（可口语）

**Limit reset**:
The cadence at which a per-key limit resets (`daily`/`weekly`/`monthly`), server-supplied.
_Avoid_: reset date

**Period spend**:
Usage counters for today/week/month in UTC (week starts Monday); server-computed, never estimated.
_Avoid_: usage（泛指时区分）— 今日/本周/本月用量

**Account burn rate**:
The burn of the whole account (all keys + web), estimated from the account balance series; shown with the wallet numbers.
_Avoid_: 消耗速率（泛指时）

**Current key burn rate**:
The burn attributed to the active key, estimated from the per-key usage series (all callers of that key).
_Avoid_: 密钥消耗（无速率语境）, key rate

**Rate display mode**:
Which rate the footer shows: this-key (default), account, both, hidden; set by /openrouter-balance rate-mode (persisted) or PI_OPENROUTER_BALANCE_RATE_MODE (env wins).

**Burn rate**:
Credits drained per hour, estimated from the account balance snapshot series; top-ups open a new segment.
_Avoid_: consumption rate, 花费速度

**Runway**:
Balance divided by burn rate, in hours/days; shown only when both exist.
_Avoid_: ETA, 耗尽时间（可口语）

**Free account**:
Never purchased credits (`is_free_tier: true`); free-model caps are 20 rpm / 50 rpd.
_Avoid_: 免费层（翻译腔）, free tier（英文上下文可用）

**Paid account**:
Has purchased credits before (`is_free_tier: false`).
_Avoid_: 非免费层（翻译腔）

**Free model**:
A model id ending in `:free`; the status is read from the active model, not the key.
_Avoid_: free（footer 标记用 ·免费/·free）

**BYOK usage**:
Spend from the user's own upstream provider keys (`byok_usage*`); shown when nonzero.
_Avoid_: 外部密钥用量（改为 自带密钥）

**Snapshot**:
One normalized reading (balance + key status + metadata); the unit of stale/keep-last-good handling.
_Avoid_: cache entry

**Fingerprint**:
HMAC of the stable `creator_user_id`; keys persistence rows and state isolation; the raw id is never persisted.
_Avoid_: user id（原始值不入库）
