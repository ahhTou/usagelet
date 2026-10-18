# usagelet

> 开发中 · 2026-10-18 · v0.3.0

本机 Agent 用量统计，**输出与 [ccusage](https://github.com/ccusage/ccusage) 20.0.21 逐字节一致**（JSON、终端表格、费用），另外完整支持 DeepSeek Harness（DSH）。源码按模块维护，打包为单个 `usagelet.mjs`；使用端无需安装 npm 包或构建工具。

**需要 Node.js >= 22.16（内置 SQLite / Zstd）。目前仅在 macOS arm64、Node.js 22.23.2 验证，其他环境未测试。** Node 22 的 SQLite 可能在 stderr 显示实验性提示。

## 下载与运行

```bash
curl -fL https://ahhtou.wang/dl/usagelet-0.2.1.mjs -o usagelet.mjs
curl -fL https://ahhtou.wang/dl/usagelet-0.2.1.mjs.sha256 -o usagelet.mjs.sha256
shasum -a 256 -c usagelet.mjs.sha256
node usagelet.mjs daily
node usagelet.mjs daily --json --by-agent -z Asia/Shanghai > usage.json
```

站点目前提供的是 v0.2.1（旧输出格式）；v0.3.0 尚未发布，可在仓库里 `npm run build` 后使用 `dist/usagelet.mjs`。

脚本只离线读取会话日志与用量表，不读取账号凭据、不联网、不上传数据。

## 与 ccusage 的关系

命令、选项与输出照搬 `ccusage daily`（统一日报）：

| | 说明 |
|---|---|
| JSON | `--json` / `--json --by-agent` / `--no-cost` 的结构、键序、整数与浮点写法与 ccusage 相同 |
| 表格 | 标题框、`Date / Agent / Models / … / Cost (USD)` 列、按终端宽度换行压缩、`--compact`、`--breakdown`、颜色规则、缺价 `WARN` 均相同 |
| 费用 | 移植 ccusage 的离线定价：内嵌价格快照就是 ccusage 20.0.21 自己 build.rs 的产物（LiteLLM 锁定版本 + models.dev 快照），模型匹配、长上下文分档、fast 倍率、DeepSeek V4 时段价、Codex 服务档位、ZCode 的 Z.ai 规则全部照搬。结果等同 `ccusage -O`；不联网刷新价格 |
| 费用模式 | `-m auto`（默认，日志里有记录费用就用记录值）、`calculate`、`display` |

默认统计 Claude Code、Codex、ZCode、DeepSeek Harness 四个来源。前三个与 ccusage 20.0.21（tag `v20.0.21`，提交 `3c5556a775ebcf1e59844d4283c8c5b30529c290`）的统计口径和输出逐字节一致；DSH 是 ccusage 不支持的来源，按 DSH 自己的口径统计（见下）。对比结果见 [VALIDATION.md](VALIDATION.md)。

| 来源 | 默认读取位置 | 关键规则 |
|---|---|---|
| Claude Code | `~/.claude/projects`、`~/.config/claude/projects` | 会话隔离、完整快照选择、侧链重放、advisor、TTL 缓存桶、记录费用与 fast 模型名 |
| Codex | `~/.codex/sessions`、`archived_sessions` | 累计差分、跨文件去重、分支 / 重写突发处理、模型回退、按请求判长上下文、服务档位 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | 只读 SQLite、已完成请求、缓存拆分、计数转换、总量补差、provider 决定是否计价 |
| DeepSeek Harness | `~/.dsh/sessions`（或 `DSH_HOME`） | 见下 |

## DeepSeek Harness

口径对齐 DSH 自身的 tokenUsage 投影（`@deepseek-ai/dsh-token-meter`），不是自行推断：

- 只有 `assistant/message` 与 `assistant/attempt` 计费：message 优先用 `data.usage`，否则取内嵌流里最后一个 usage 块；
- 同一 `(turn, step)` 后一个样本替换前一个（相同则不变），`llm/retry-started` 之后的重试另算一次；
- DSH 的 `inputTokens` 就是未命中缓存的输入，与缓存读写互斥，总量为四项之和；
- **去重**：分叉会话、fork 子智能体继承的前缀是父会话事件的副本，只计每个会话继承截点之后的自有事件（截点与 DSH 的 `inheritedEventCount` 相同）；同一会话目录只读编号最高的格式代际（`session.vN.jsonl[.zstd]`）；同一会话 id 出现在多份日志里只算一份；
- 支持 v0–v4 全部历史格式（含 v0/v1 的顶层流式块与打包行），支持拼接 Zstd 帧与未压缩两种编码；写入中断留下的残行 / 残帧按 DSH 规则丢弃，损坏帧告警；
- 模型名用消息来源里的模型 id（如 `deepseek-flash`），Agent 显示名为 `DeepSeek Harness`（JSON 里是 `dsh`，`--agent deepseek` 作为别名）；
- 费用先试 `provider/model` 再试 `model`，与社区 DSH 适配器（oksure/ccusage 分支）一致；查不到价时与 ccusage 一样记 0 并列入 `unpricedModels`。

DSH 的压缩摘要请求（`compaction/summary`）有用量记录，但 DSH 自己的 tokenUsage 不计，所以只在 `--extended` 下计入；会话标题、联网搜索的 LLM 请求日志里没有用量，无法统计。正确性用 DSH 自己的代码核对：v0–v4 共 647 个官方快照样本、本机真实会话与 5000 组随机事件序列全部一致，见 VALIDATION.md。

## 参数

```bash
node usagelet.mjs daily [选项]
```

ccusage 同名选项：`-j/--json`、`-s/--since`、`-u/--until`（`YYYY-MM-DD` 或 `YYYYMMDD`，含边界）、`--last N`、`-z/--timezone`（也可写 `--tz`）、`--by-agent`、`-m/--mode auto|calculate|display`、`-o/--order asc|desc`、`-b/--breakdown`、`--compact`、`--no-cost`、`--color/--no-color`；`-O/--offline`、`--all` 接受但无影响。默认时区与 ccusage 相同为系统时区，同步到站点时建议明确 `-z Asia/Shanghai`。支持 `CCUSAGE_MODEL_ALIASES`、`COLUMNS`、`NO_COLOR`、`FORCE_COLOR`。

usagelet 选项：

- `--agent claude,codex,zcode,dsh`：选择来源（默认全部）；
- `--source 来源=路径`：可重复，指定日志目录 / 文件，ZCode 指向 `db.sqlite` 文件本身；
- `--extended`：扩展口径，额外读 Codex `.jsonl.zst` 归档与独立 compaction、DSH 压缩摘要，保留 v0.1 的读取方式；**不保证与 ccusage 相同**（兼容 v0.2 的 `--mode extended` 写法）；
- `CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME`、`CODEX_HOME`、`ZCODE_HOME`、`DSH_HOME` 均支持，前三个及 `DSH_HOME` 可逗号分隔多个目录。

输出写 stdout，诊断写 stderr。退出码：`0` 完整统计，`2` 有数据质量警告（stderr 列出 `[代码] 来源: 说明`），`1` 参数或读取错误。库接口 `collect()` 返回 `{ metadata, rows, daily, totals, detectedAgents }`，`daily` / `totals` 即 `--json --by-agent` 的内容，`metadata` 含来源状态与警告。

## 开发与验证

```bash
npm ci
npm run build       # src/ → dist/usagelet.mjs 与 SHA-256 清单
npm test            # 147 项 ccusage 原始输出逐字节对比 + DSH 官方口径 + 定价单测 + 扩展 / 回归测试
npm run compare     # 本机真实日志对照 ccusage（需要 PATH 上有 ccusage 20.0.21，或设 CCUSAGE_BIN）
npm run test:oracle # 用真实 ccusage 重新核对固定样本（--record 重写 test/golden.json.gz）
npm run test:dsh    # 用本机 DeepSeek Harness 桌面版自带代码核对 DSH 样本
```

构建工具 esbuild、格式化工具 Prettier 为锁定版本的开发依赖，产物不含第三方运行依赖。模块分工：

- `src/adapters/`：各来源采集器（`dsh.mjs` 为 DeepSeek Harness）；
- `src/pricing/`：ccusage 离线定价（`snapshot.mjs` 由 `scripts/pricing-snapshot.mjs` 从 ccusage build.rs 产物生成）；
- `src/report/`、`report.mjs`：ccusage 统一日报的聚合、JSON 与表格；
- `src/rows.mjs`、`cost.mjs`、`collect.mjs`、`cli.mjs`：日汇总、各来源计费、采集编排与命令行。

现有 `ahhtou.wang` 同步链路尚未切换，也未改动线上统计数据。

协作与开发计划见 [AGENTS.md](AGENTS.md)，`CLAUDE.md` 是其软链接。代码与分发产物保留 [MIT 许可](LICENSE)；内嵌价格数据来自 LiteLLM（MIT）与随 ccusage 源码分发的 models.dev 快照，DSH 测试样本来自 deepseek-harness（MIT，见 `test/fixtures/dsh/`）。
