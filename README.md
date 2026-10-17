# usagelet

> 开发中 · 2026-10-18 · v0.2.1

参考 [ccusage](https://github.com/ccusage/ccusage) 的本机 Agent 用量统计工具。源码按模块维护，开发时打包为单个 `usagelet.mjs`；使用端无需安装 npm 包或构建工具。

**需要 Node.js >= 22.16，包含内置 SQLite / Zstd 支持。目前仅在 macOS arm64、Node.js 22.23.2 验证，其他环境未测试。** Node 22 的 SQLite 可能在 stderr 显示实验性提示。

## 下载与运行

站点目前仍是 v0.2.0 构建；v0.2.1 的回归修复（见 [VALIDATION.md](VALIDATION.md#v021-回归修复)）尚未发布，需要时从源码 `npm run build` 得到 `dist/usagelet.mjs`。

```bash
curl -fL https://ahhtou.wang/dl/usagelet-0.2.0.mjs -o usagelet.mjs
curl -fL https://ahhtou.wang/dl/usagelet-0.2.0.mjs.sha256 -o usagelet.mjs.sha256
shasum -a 256 -c usagelet.mjs.sha256
node usagelet.mjs daily
node usagelet.mjs daily --json --tz Asia/Shanghai > usage.json
```

脚本仅离线读取会话日志及用量表，不读取账号凭据、不上传数据、不请求定价。

## 默认口径：对齐 ccusage 20.0.21

默认 `--mode ccusage`，扫描 **Claude Code、Codex、ZCode**。兼容基线固定为 ccusage **20.0.21**（源码 tag 对应提交 `3c5556a775ebcf1e59844d4283c8c5b30529c290`）。

本次对齐范围是 `daily --json --by-agent -O` 的**日期、Agent、模型分组，输入 / 输出 / 缓存写入 / 缓存读取四项 token，以及日、Agent、全局总 token**。JSON 的附加诊断、字段顺序、终端样式与 ccusage 不必相同。首版不实现费用估算；`cost` 为 `null`，不能当作费用兼容版。

| 来源 | 默认读取位置 | 已迁移的关键规则 |
|---|---|---|
| Claude Code | `~/.claude/projects`、`~/.config/claude/projects` | 会话隔离、完整快照选择、侧链重放、AgentProgress、advisor、TTL 缓存桶、缺省值、fast 模型名 |
| Codex | `~/.codex/sessions`、`archived_sessions` | 累计差分、跨文件事件去重、活动文件优先、分支前缀 / 截止时间 / 重写时间突发处理、headless 格式、模型回退 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | 只读 SQLite、已完成请求、旧表结构、缓存拆分、用量 id 去重、计数转换、总量补差 |

与上游保持相同默认规则：

- **默认时区为系统时区**，建议同步到站点时明确传 `--tz Asia/Shanghai`。
- 支持 `CCUSAGE_MODEL_ALIASES` 的 JSON 或 `a=b,c=d` 写法；Codex 的 `codex-auto-review` 按基线版本内置发布日期表映射，缺模型时回退到 `gpt-5`。这些是上游兼容规则，非 usagelet 自行猜测。
- ccusage 20.0.21 不读 Codex 压缩归档，也不单独增加 compaction 请求；默认模式保持相同范围。
- Claude 未报告的可选缓存桶、ZCode 旧结构缺少的缓存列，按上游语义补零。不能用 v0.1.0 的缺失值规则替换默认兼容语义。
- ZCode 数据库打不开、缺少 `model_usage` / `session` 表或必需列时，与上游一样只跳过这个库，Claude Code、Codex 照常统计；上游只写调试日志，usagelet 另记 `zcode_schema` / `zcode_unreadable` 警告并以退出码 2 结束。
- ZCode 的 `computed_total_tokens` 可能大于四项和；输出缺失时补输出，否则保留 `extraTotalTokens`，总量不能简单强制等于四项和。Codex 的记录总量同样按上游保留。

## 扩展模式与 DeepSeek

```bash
node usagelet.mjs daily --mode extended --json --tz Asia/Shanghai
node usagelet.mjs daily --agent deepseek --json --tz Asia/Shanghai
```

`--mode extended` 保留 v0.1 的四来源采集，额外读取 Codex `.jsonl.zst` 和独立 compaction 用量，保留原始模型标识；**它不声明与 ccusage 20.0.21 等价**。默认兼容模式的判断和对账不依赖排除这些差异。

DeepSeek 不在兼容契约内：即使在默认模式用 `--agent deepseek` 选中，`metadata.compatibility` 也为 `null`。DeepSeek Harness 默认读取 `~/.dsh/sessions`，支持 JSONL / 拼接帧 `.jsonl.zstd`；本机 v4 已验证，历史 v0–v3 未逐版本实机验证。带种子历史的会话报告不完整。Qoder 按用户要求暂缓。

## 参数与输出

```bash
node usagelet.mjs --agent claude,codex --since 2026-10-01 --until 2026-10-18 --tz Asia/Shanghai --json
node usagelet.mjs --agent zcode --source zcode=/path/to/db.sqlite --json
node usagelet.mjs --agent deepseek --source deepseek=/path/to/sessions --json
node usagelet.mjs --help
```

`--source 来源=路径` 可以重复传入，直接指定日志目录 / 文件或 ZCode 数据库；ZCode 必须指向 `db.sqlite` 文件本身，传目录会直接报错。`--agent` 会去掉空白和空项。支持 `CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME`、`CODEX_HOME`、`ZCODE_HOME`、`DSH_HOME`；前三种工具主目录环境变量支持逗号分隔多个目录。起止日期包含边界，也接受 `YYYYMMDD`；命令行和 `collect()` 库接口用同一套规范化与校验，无效日期或起始晚于结束直接报错。过滤在累计基线与去重之后执行。

JSON 保留 `daily[].agents[].modelBreakdowns[]`，并提供各级总计。`metadata.compatibility` 明确基线（只选三来源时才有值），`metadata.mode` 明确模式。`metadata.complete`、`warnings` 和来源状态用于诊断。异常记录与上游一样被跳过，且不是每种都有提示：默认模式下 Claude 与上游同样先按 `"usage":{` 预过滤，只解析含用量的行，其他损坏行不读也不提示；ZCode 库被跳过时会警告。扩展模式未报告的字段保留 `null`，另附 `knownTokens` / `missingFields`。

退出码：`0` 正常，`2` 数据质量警告，`1` 参数、读取或不支持的数据错误。诊断写 stderr，JSON 写 stdout。只保证 JS 安全整数范围内的精确计数，聚合溢出会拒绝。

## 开发与验证

```bash
npm ci
npm run build       # src/ → dist/usagelet.mjs 与 SHA-256 清单
npm test            # 构建产物 + 126 项上游固定预期回归 + 18 项扩展测试 + 7 项回归修复测试
```

构建工具 esbuild、格式化工具 Prettier 均为锁定版本的开发依赖，产物不含第三方运行依赖。模块分工：

- `src/adapters/`：三个来源的兼容采集器、扩展采集器与 DeepSeek。
- `src/compat.mjs`、`src/json.mjs`：上游数值、别名、时间戳和 JSON 边界语义。
- `src/aggregate.mjs`、`collect.mjs`、`cli.mjs`：聚合、路径发现及命令行。
- `scripts/build.mjs`：打包；`scripts/oracle.mjs`：直接调用基线 ccusage 生成并比较固定预期。

若已安装 ccusage 20.0.21：

```bash
CCUSAGE_BIN=/absolute/path/to/ccusage npm run test:oracle
CCUSAGE_BIN=/absolute/path/to/ccusage node scripts/compare.mjs --tz Asia/Shanghai
```

对比不会先重命名结果、删除 compaction 数字或只比较相同的行。`test/golden.json` 是 42 组脱敏样本在三个时区下的真实 ccusage 输出预期；不安装 ccusage 也可运行完整回归测试。更详细的规则映射与冻结本机快照对账见 [VALIDATION.md](VALIDATION.md)。

现有 `ahhtou.wang` 同步链路尚未切换，也未改动线上统计数据。线上替换需另行验证凭证、设备身份及减少保护。

协作与开发计划见 [AGENTS.md](AGENTS.md)，`CLAUDE.md` 是其软链接。代码与分发产物保留 [MIT 许可](LICENSE)。
