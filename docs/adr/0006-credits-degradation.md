# 0006 — /credits failure is a state, not an error

Any 401/403 on `/credits` sets `balanceUnavailable`, hides the balance line, shows 「账户余额 —（密钥无账户读取权限）」, and keeps the key-scoped view working. It is retried only on `--refresh` or auth re-resolution, never on every poll, and never renders an error state.
