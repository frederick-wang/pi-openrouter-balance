# 0003 — Burn rate from the account balance series, not key usage

`usage` is per-key; a fresh key reports 0 while the account keeps spending, so key-usage-based rates are wrong for real users. The balance series (`totalCredits − totalUsage`) decreases with use and jumps on purchases; the estimator walks back past top-up boundaries (deepseek pattern) and requires ≥3 samples over ≥1h. Runway is balance/rate and only shown when both exist.
