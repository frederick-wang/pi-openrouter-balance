# 0003 — Burn rate from the account balance series, not key usage

`usage` is per-key; a fresh key reports 0 while the account keeps spending, so key-usage-based rates are wrong for real users. The balance series (`totalCredits − totalUsage`) decreases with use and jumps on purchases; the estimator walks back past top-up boundaries (deepseek pattern) and requires ≥3 samples over ≥1h. Runway is balance/rate and only shown when both exist.

## Amendment (0.1.1 — dual rates)

Account burn stays the wallet view (all keys + web). A second, per-key rate is computed from the per-key `usage` series: keyed rows carry HMAC(label) (`keyFp`) so switching keys cannot mix series, any decrease starts a new segment, and the same ≥3 samples / ≥1h gate plus a minimum $0.01 delta applies (cent quantization and accounting lag). The key rate labels 「该密钥所有调用者」 — the key may be shared by other clients; it is never implied to be pi-only. Footer view is selected by `PI_OPENROUTER_BALANCE_BURN=account|key` (default account); the report always shows both. No persisted toggle: an enum is not worth a mutable-config surface (three-party consult).
