# 0008 — Privacy boundary

Credentials resolve through `getProviderAuth("openrouter")` only; no auth-file reads or writes. Keys/tokens/bearer values live in memory for the request and are redacted from errors. Snapshots contain numbers and a HMAC fingerprint only; the live-check script prints sanitized fields only and is user-consented (read-only GET /key + /credits).
