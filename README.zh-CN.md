# pi-openrouter-balance

[English](./README.md) | 简体中文

> **非官方扩展。** 与 OpenRouter 无任何关联。数据来自 OpenRouter API（`/api/v1/key` 与 `/api/v1/credits`），使用 pi 自身的凭据；这些接口不是公开文档化的契约，随时可能变化，本扩展也可能随时失效。

在 [pi coding agent](https://github.com/earendil-works/pi-mono) 的 footer 中展示 OpenRouter 账户余额与密钥用量，并提供完整的 `/openrouter-balance` 报告。

```
openrouter $149.70 ↓$0.42/h
openrouter $60.00 ███████░ 68% $6.80/$20 ↓$0.42/h   ← 密钥设了额度上限
```

## 功能

使用 `openrouter` 模型时：账户余额（充值 − 已用）、密钥额度上限进度条（剩余/上限；密钥不限量时不画条——不造假）、周期用量（今日/本周/本月，UTC 口径）、自带密钥（BYOK）非零时单独展示、免费账户/付费账户状态、当前模型是 `:free` 时的免费模型提示、基于余额历史估算的消耗速率、以及两者齐备时的可用时长估算。告警：余额低于 $20/$5（环境变量可改）、设了上限的密钥同样按阈值盯剩余额度、OpenRouter 返回 402 时无条件提示。

## 安装

```bash
pi install npm:pi-openrouter-balance
```

或从 git 安装：

```bash
pi install git:github.com/frederick-wang/pi-openrouter-balance
```

需要在 pi 中登录 OpenRouter（`/login` 选择 OpenRouter，或设置 `OPENROUTER_API_KEY`）。

## 命令

- `/openrouter-balance` — 完整报告（上述全部信息）。
- `/openrouter-balance --json` — 稳定的机器可读快照（键名固定英文，不含凭据或指纹）。TUI 模式在 overlay 中展示；`print` 模式输出到 stdout；其他模式拒绝。
- `/openrouter-balance --refresh` — 跳过限流立即刷新。

## 认证与隐私

- 凭据只通过 pi 自身的 `openrouter` 认证解析（环境变量密钥或 OAuth 换发的密钥）；扩展从不读写凭据文件。
- 密钥/token 仅存在于请求内存中，错误信息一律脱敏。
- 持久化到 `~/.pi/agent/pi-openrouter-balance-snapshots.jsonl` 的快照只含数字，按键控的是 OpenRouter 用户 id 的 HMAC 指纹——绝不含密钥或原始 id。
- 无遥测；除两个只读接口外无任何网络请求。

## 配置

- `PI_OPENROUTER_BALANCE_LANG=zh|en` — 界面语言（默认：跟随系统语言，再英文）。
- `PI_OPENROUTER_BALANCE_WARN` — 余额警告阈值（美元，默认 20）。
- `PI_OPENROUTER_BALANCE_ERROR` — 余额错误阈值（美元，默认 5）。
- `PI_CODING_AGENT_DIR` — pi 配置目录（快照位置沿用 pi 自身约定）。

## 说明

- 如果 OpenRouter 某天不再允许普通密钥读取 `/credits`，扩展会自动降级为密钥级数据并附一行说明——绝不会变成坏掉的体验。
- 消耗速率需要至少三个、跨度一小时以上的余额样本才会出现；算得诚实才显示。
- 进度条只为密钥额度上限绘制；没设上限时 footer 只显示数字，不发明比例。
