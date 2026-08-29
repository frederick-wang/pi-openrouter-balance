# 0003 — Burn rate from the account balance series, not key usage

`usage` is per-key; a fresh key reports 0 while the account keeps spending, so key-usage-based rates are wrong for real users. The balance series (`totalCredits − totalUsage`) decreases with use and jumps on purchases; the estimator walks back past top-up boundaries (deepseek pattern) and requires ≥3 samples over ≥1h. Runway is balance/rate and only shown when both exist.

## Amendment (0.1.1 — dual rates, user-driven)

Account burn stays the wallet view (all keys + web). A second, per-key rate is computed from the per-key `usage` series: rows carry HMAC(label) (`keyFp`) so key switches cannot mix series, any decrease starts a new segment, and the same ≥3 samples / ≥1h gate plus a minimum $0.01 delta applies (cent quantization and accounting lag). The key rate is labelled 「该密钥所有调用者」 — the key may be shared by other clients; never implied to be pi-only.

Rate display modes (user decision, replacing the earlier env-only consult): this-key (default), account, both, hidden, selected by `/openrouter-balance rate-mode` (interactive picker in TUI; persisted to `~/.pi/agent/pi-openrouter-balance-prefs.json` 0600 atomic/O_NOFOLLOW writes) with `PI_OPENROUTER_BALANCE_RATE_MODE` env on top (12-factor precedence env > persisted > default). The report always shows both rates with full labels. Labels are not guaranteed unique across keys — the series is additionally protected by decrease-segmentation, and the limitation is documented rather than guessed at.
