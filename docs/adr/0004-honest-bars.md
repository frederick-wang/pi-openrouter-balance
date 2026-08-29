# 0004 — Bars express only "remaining over limit"

The footer and report draw a GLM-style 8-cell bar for a per-key credit limit (remaining/limit, green ≥50%, yellow 20–50%, red <20%). With no limit set there is no denominator and no bar is drawn; balance is never turned into a ratio (totalCredits grows with purchases, "balance as fraction of lifetime purchases" misleads), and burn rate is a trend, expressed as text.
