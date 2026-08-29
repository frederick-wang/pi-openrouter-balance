# 0002 — Persistence keyed by HMAC(user id), never by the bearer token

`/api/v1/key` returns a stable `creator_user_id`. Snapshots and state isolation use `HMAC(creator_user_id)`; the raw id and any bearer/key value are never persisted, logged, or shipped. Key rotation or token refresh cannot churn identity, which is what a bearer-derived fingerprint would do.
