# pi-openrouter-balance

[English](./README.md) | 简体中文

> **非官方扩展。** 与 OpenRouter 无任何关联。数据来自 OpenRouter API（`/api/v1/key` 与 `/api/v1/credits`），使用 pi 自身的凭据；这些接口不是公开文档化的契约，随时可能变化，本扩展也可能随时失效。

在 [pi coding agent](https://github.com/earendil-works/pi-mono) 的 footer 中展示 OpenRouter 账户余额与密钥用量，并提供完整的 `/openrouter-balance` 报告。

```
openrouter $149.70 ↓$0.42/h
openrouter $60.00 ███████░ 68% $6.80/$20 ↓$0.42/h   ← 密钥设了额度上限
```

## 安装

```bash
pi install npm:pi-openrouter-balance
```

或从 git 安装：

```bash
pi install git:github.com/frederick-wang/pi-openrouter-balance
```

需要在 pi 中登录 OpenRouter（`/login` 选择 OpenRouter，或设置 `OPENROUTER_API_KEY`）。

## 用法

### Footer

当前模型的 provider 是 `openrouter` 时显示；换到其他 provider 自动清除。

| 元素 | 含义 |
| --- | --- |
| `$149.70` | 账户余额：充值 − 已用（可能为负；负数即 402 风险） |
| `$60.00` | 同上；密钥设了额度上限时，进度条接在余额后面 |
| `███████░` | 8 格剩余进度条，**仅在密钥设了额度上限时出现**（剩余/上限）；没设上限不画条，不发明数据 |
| `68%` | 额度上限的剩余百分比 |
| `$6.80/$20` | 该密钥的剩余金额 / 上限金额 |
| `↓$0.42/h` | 消耗速率：基于余额历史估算的每小时花费（需要 ≥3 个、跨度 1 小时以上的样本；充值跳变会开启新窗口）。`PI_OPENROUTER_BALANCE_RATE_MODE=key` 可把 footer 切到密钥速率（形式相同）；默认账户速率 |
| `~` | 前缀：上次刷新失败，保留旧数字（标记陈旧，绝不当最新数据展示） |
| `·免费` / `·free` | 当前模型 id 以 `:free` 结尾（免费模型状态看模型，不是看密钥） |
| 颜色 | 进度条：剩余 ≥50% 绿，20–49% 黄，<20% 红 |

整行替换的状态文案：

| 状态 | 含义 |
| --- | --- |
| `n/a` | 正在加载或无数据 |
| `认证错误` / `auth error` | 凭据被拒（会先重新解析一次再判定） |
| `限流中` / `rate limited` | OpenRouter 返回 429；已安排重试 |
| `额度用尽` / `no credits left` | 真实请求（或 credits 接口）返回 402；轮询不会停止 |

### 告警

每个状态转换一次：

| 触发 | 文案（中文） |
| --- | --- |
| 余额 ≤ `PI_OPENROUTER_BALANCE_WARN`（默认 $20） | `OpenRouter 余额 $18.20 已低于 $20。` |
| 余额 ≤ `PI_OPENROUTER_BALANCE_ERROR`（默认 $5） | `OpenRouter 余额 $4.10 已低于 $5。` |
| 密钥设了上限时，同一阈值比剩余额度 | `OpenRouter 剩余额度 $6.80 已低于 $20。` |
| 任意请求（或 credits 接口）返回 402 | `OpenRouter 额度用尽。` |

回升即重新武装阈值（超过上次值即解除，带浮点容差）；任何回升都不叫"充值"。免费账户（从未购买）不触发低余额告警——阈值保护的是钱包，而免费账户钱包为零是常态；402 始终保持无条件。

### `/openrouter-balance`

报告 overlay，各分区含义：

| 分区 | 含义 |
| --- | --- |
| 账户余额 | 账户级 充值 − 已用；明细行给出两个数字 |
| 额度上限 | 密钥级上限：剩余进度条 + 百分比 + 剩余/上限 + 重置节奏（`daily`/`weekly`/`monthly`，新值原样透传）；未设置时显示「未设置（不限额）」；绝不画假的 0% 条 |
| 密钥标签 | 服务端返回的密钥标签（它自己的脱敏形态）+ 付费账户（已购买额度）/ 免费账户（从未购买额度） |
| 今日/本周/本月 (UTC) | 服务端计算的周期用量；周从周一开始；明确标注 UTC（"今日"在北京时间 08:00 切换） |
| 自带密钥（BYOK） | 你自己上游密钥产生的花费；非零才显示 |
| 账户消耗速率 | 整个账户（全部密钥+网页）的每小时花费；与它旁边的钱包数字同口径 |
| 密钥消耗速率 | 这把密钥的每小时花费（用它的所有客户端合计；同样门槛 + 最小增量 ≥$0.01）；绝不暗示"只是 pi 的消耗" |
| 余额可用时长 | 余额 ÷ 速率；两者齐备才显示 |
| 模型状态 | 仅当前模型 id 以 `:free` 结尾时出现：免费模型限额（20 次/分 · 50 次/日）只对免费账户给出数字；付费账户只给状态不给限额猜测 |
| 数据行 | 新鲜度 + 来源；`(~)` 表示陈旧 |

`/openrouter-balance --json` 输出稳定 schema（键名固定英文；不含凭据与指纹）——TUI 模式显示在 overlay，print 模式输出到 stdout，其他模式拒绝。

`/openrouter-balance --refresh` 跳过限流立即刷新。

命令在非 openrouter 模型下也能用；它不会把 footer 打开。

### 刷新

激活时与执行命令时抓取；每次回合稳定后至多 60 秒一次；openrouter 模型激活期间每 5 分钟心跳一次；429 遵循 `Retry-After` 并安排一次重试；401/403 先重新解析凭据一次再判定。若 `/credits` 被拒（服务端可能某天执行文档中的管理密钥规则），扩展自动降级为密钥级数据并附一行说明；瞬时失败保留上次余额。

## 认证与隐私

- 凭据只通过 pi 自身的 `openrouter` 认证解析（环境变量密钥或 OAuth 换发的密钥）；扩展从不读写凭据文件。
- 密钥/token 仅存在于请求内存中，错误信息一律脱敏。
- 持久化到 `~/.pi/agent/pi-openrouter-balance-snapshots.jsonl` 的快照只含数字，按键控的是 OpenRouter 用户 id 的 HMAC 指纹——绝不含密钥或原始 id。
- 无遥测；除两个只读接口外无任何网络请求。

## 配置

- `PI_OPENROUTER_BALANCE_LANG=zh|en` — 界面语言（默认：跟随系统语言，再英文）。
- `PI_OPENROUTER_BALANCE_WARN` — 余额警告阈值（美元，默认 20）。
- `PI_OPENROUTER_BALANCE_ERROR` — 余额错误阈值（美元，默认 5）。
- `PI_OPENROUTER_BALANCE_RATE_MODE=key|account|both|hidden` — footer 显示哪种速率（默认 `key`；报告始终显示两套）。`/openrouter-balance rate-mode` 会把同一选择持久化到 `~/.pi/agent/pi-openrouter-balance-prefs.json`；环境变量优先，命令执行时会明说。
- `PI_CODING_AGENT_DIR` — pi 配置目录（快照位置沿用 pi 自身约定）。

## 说明

- 消耗速率需要至少三个、跨度一小时以上的余额样本才会出现；算得诚实才显示。
- 进度条只为密钥额度上限绘制；没设上限时 footer 只显示数字，不发明比例。
- 密钥的 `usage` 计数是按密钥计的（新 key 可能是 0 而账户在持续花钱）——只做展示，绝不用于速率计算。
