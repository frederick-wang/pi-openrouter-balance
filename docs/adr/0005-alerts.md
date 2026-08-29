# 0005 — Balance thresholds with defaults; 402 unconditional

Low-balance alerts use `PI_OPENROUTER_BALANCE_WARN` (default $20) and `_ERROR` (default $5), re-armed on recovery (never labeled a top-up); when a per-key limit exists the same thresholds apply to the remaining limit. A server 402 (observed via `after_provider_response` status; cause not distinguishable) raises one unconditional toast and an `额度用尽` state. Free accounts get no extra alerts.
