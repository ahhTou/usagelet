# usagelet

> 开发中 · 2026-10-18 · v0.1.0 首版采集器

参考 [ccusage](https://github.com/ccusage/ccusage)，以 JavaScript 实现本机 Agent 用量采集、去重和按日汇总。交付物就是源码文件 `usagelet.mjs`：下载后用 Node.js 运行，无需 npm install、编译、打包或平台专用二进制。

**运行要求：Node.js >= 22.16，且包含内置 Zstd / SQLite 支持。当前只在 macOS arm64、Node.js 22.23.2 验证；其他环境未测试。** Node 22 的 SQLite 可能输出实验性提示，不影响 JSON stdout。

## 下载运行

```bash
curl -fL https://ahhtou.wang/dl/usagelet-0.1.0.mjs -o usagelet.mjs
curl -fL https://ahhtou.wang/dl/usagelet-0.1.0.mjs.sha256 -o usagelet-0.1.0.mjs.sha256
shasum -a 256 -c usagelet-0.1.0.mjs.sha256
node usagelet.mjs daily
node usagelet.mjs daily --json > usage.json
```

校验清单中的文件名是 `usagelet.mjs`。也可以直接从此仓库取得源码运行。脚本只离线读取会话日志和用量表，不读取账号凭据，不上传对话或统计，不联网获取定价。

## 支持情况

以下是 Agent 工具 / 数据来源，内部模型标识原样保留。

| 来源 | 默认位置 | 当前状态 |
|---|---|---|
| Claude Code | `~/.claude/projects`、`~/.config/claude/projects` | 已实现；本机真实数据对账通过 |
| Codex | `~/.codex/sessions`、`~/.codex/archived_sessions` | 已实现普通 JSONL、`.jsonl.zst`、累计差分及 compaction 用量 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | 已实现只读 SQLite；本机真实数据对账通过 |
| DeepSeek Harness | `~/.dsh/sessions` | 已实现 v0–v4 JSONL / `.jsonl.zstd`、拼接 Zstd 帧；本机 v4 数据已验证，早期格式仅兼容已知字段，未逐版本实机测试 |
| Qoder | — | 按用户要求暂缓接入 |

支持 `CLAUDE_CONFIG_DIR`（逗号分隔多个目录）、`XDG_CONFIG_HOME`、`CODEX_HOME`、`ZCODE_HOME`、`DSH_HOME`。环境变量指向工具主目录；`--source` 直接指向日志目录、单个日志文件，或 ZCode 数据库文件。

```bash
node usagelet.mjs --agent claude,codex --tz Asia/Shanghai --since 2026-10-01 --until 2026-10-18
node usagelet.mjs --agent deepseek --source deepseek=/path/to/sessions --json
node usagelet.mjs --agent zcode --source zcode=/path/to/db.sqlite --json
node usagelet.mjs --help
```

`--source` 可重复指定以合并多个路径。`--agent` 是选择范围，默认扫描四个已实现的来源。起止日期均包含边界，默认按 `Asia/Shanghai` 切日。为了正确求累计差分，日期过滤在解析和去重之后执行。

## 输出与统计口径

JSON 的主结构为：

- `metadata`：版本、时区、来源状态、完整性标记和数据质量警告。
- `daily[].agents[].modelBreakdowns[]`：按日期、Agent、原始模型汇总的四项 token。
- `totals`：相同口径的总计。

四项为 `inputTokens`（不含缓存的输入）、`outputTokens`、`cacheCreationTokens`、`cacheReadTokens`，互不重叠。推理 token 已包含在输出中，不再重复加一次。未报告的字段返回 `null`，`knownTokens` 提供已知部分，`missingFields` 明确缺什么。`totalTokens` 仅在四项完整时给出；首版不估算价格，`cost` 为 `null`。

来源状态区分 `ok`、`not_found` 与 `no_usage`。`metadata.complete` 只表示本次读取范围内没有已识别的数据质量问题，不保证工具尚未记录或已删除的历史也完整。不存在的默认来源可以正常跳过；明确指定的路径不存在、数据库结构不匹配、未知日志版本、损坏压缩文件会失败。

退出码：`0` 正常完成，`2` 有缺失字段或数据质量警告，`1` 参数、读取或格式错误。诊断写 stderr，JSON 写 stdout。上传前必须检查退出码与 `metadata.complete`，不能只看输出中是否有 `daily`。

### 去重与已知边界

- Claude：按会话、message.id、requestId 去重，保留完整且总量更大的快照，优先主线而非侧链重放；advisor 迭代单独按原模型统计。缓存写入优先取详细 TTL 桶之和，与 ccusage 20.0.21 对齐。
- Codex：相同累计快照不重复计数，缺少单次计数时按累计差分；同一会话的普通 / 压缩副本合并。分支与已找到父会话的用量前缀匹配，缺父会话时标记不完整；尚未实现 ccusage 对时间被重写的分支前缀的启发式推断。单独的 compaction 请求只在有对应标记、且未被累计记录覆盖时计入。
- ZCode：仅统计 `completed` 请求，按用量 id 去重；input 中包含的缓存拆开存储。本地约 30 天滑动窗口造成的历史缺失无法恢复。
- DeepSeek：只读每个会话目录最高版本 generation；优先顶层用量，否则取嵌入 stream 最后一个 usage。同一步的快照替换，明确重试边界后累加。带种子历史的会话标记不完整，尚未验证其重放去重。单个 Zstd 帧或解压结果超过 64 MiB 时拒绝，避免无界内存占用。

保留 `codex-auto-review` 等原始标识，不根据日期推测实际模型。更详细的对账记录和来源见 [VALIDATION.md](VALIDATION.md)。

## 与 ahhtou.wang 的关系

首版 JSON 保留 ccusage 的 `daily[].agents[].modelBreakdowns[]` 结构，兼容 `daily --json --by-agent -O` 调用形状；这是统计结构兼容，尚未承诺完全等价替换。**目前没有替换线上 ccusage 同步链路，也没有自动推送功能。** 后续接入需校验缺失值、一次性凭证、设备身份、整日替换及减少保护。

## 开发

```bash
node --check usagelet.mjs
node --test test/*.test.mjs
```

没有运行依赖，也没有构建步骤；仓库里的 `package.json` 仅为开发命令提供便利，单文件运行不需要它。开发计划和提交署名规范见 [AGENTS.md](AGENTS.md)，`CLAUDE.md` 是它的软链接。

许可证为 MIT。参考项目的版权与许可保留在 [LICENSE](LICENSE) 及单文件脚本内。
