# 兼容性验收

> 2026-10-18 · v0.3.0 · 输出与 ccusage 20.0.21 逐字节一致；DeepSeek Harness 对齐 DSH 官方口径

## 对齐契约

**Claude Code、Codex、ZCode**：`ccusage daily` 的全部输出逐字节相同——`--json`、`--json --by-agent`、`--json --no-cost` 的文本（结构、键序、整数 / 浮点写法、`unpricedModels`），以及终端表格的 stdout 与 stderr（标题框、列宽适配与换行、`--compact`、`--no-cost`、`--breakdown`、Total 行、缺价 `WARN`、紧凑提示）。费用等同 `ccusage -O`（内嵌价格快照），费用模式 `auto` / `calculate` / `display` 均对齐。

上游版本固定为 tag `v20.0.21`，提交 [`3c5556a775ebcf1e59844d4283c8c5b30529c290`](https://github.com/ccusage/ccusage/tree/v20.0.21)；本机基线程序打印 `ccusage 20.0.21`，对照脚本先检查版本。后续上游升级必须更新契约并重跑对比。比较时不重命名、不过滤、不容差：字符串完全相同才算通过。

**DeepSeek Harness**：ccusage 不支持 DSH。usagelet 按 DSH 自己的 tokenUsage 投影统计，跨会话只计自有事件，并用 DSH 自带代码核对（见下）。DSH 行的 JSON / 表格格式与其他来源相同，Agent 为 `dsh` / `DeepSeek Harness`。

`--extended` 扩展口径不在契约内。

## 源码映射

路径均相对于上述 ccusage 版本。

| 上游 | usagelet | 内容 |
|---|---|---|
| `rust/crates/ccusage-core/src/pricing.rs` | `src/pricing/map.mjs`、`keys.mjs`、`deepseek.mjs`、`aliases.mjs` | 价格表加载、models.dev 认领规则与 exactOnly、模糊匹配与边界、内置价格、长上下文档、DeepSeek V4 时段价、fast 倍率 |
| `rust/crates/ccusage-core/build.rs` + `flake.lock` | `src/pricing/snapshot.mjs`（`scripts/pricing-snapshot.mjs` 生成） | 内嵌快照直接取 build.rs 产物，LiteLLM 锁定 `4b368bf0669cfd3268b780eea6c69497b9a51850` |
| serde_json 1.0.151（运行期无 `float_roundtrip`） | `src/pricing/serde-json.mjs` | 价格 JSON 按 serde 的非正确舍入浮点算法与类型规则解码 |
| `rust/crates/ccusage-core/src/cost.rs` | `src/pricing/cost.mjs` | 5m / 1h 缓存、两段式与边际分档、fast 倍率、费用模式、缺价判定 |
| `rust/adapters/codex/src/aggregate.rs`、`report.rs`、`speed.rs`、`parser.rs` | `src/pricing/codex.mjs`、`src/cost.mjs`、`src/adapters/codex.mjs` | 按日分组、按请求判长上下文、时间戳分桶、服务档位记录与合并、config.toml 档位 |
| `rust/adapters/claude/src/daily.rs` | `src/adapters/claude.mjs`、`src/rows.mjs` | 去重前计价（替换规则比较算出的费用）、日累加顺序 |
| `rust/adapters/zcode/src/loader.rs`、`parser.rs` | `src/adapters/zcode.mjs`、`src/cost.mjs` | provider 决定是否计价、Z.ai 缓存写入按输入价、按时间稳定排序 |
| `rust/crates/ccusage-core/src/summary.rs`、`output.rs` | `src/rows.mjs`、`src/report.mjs` | UsageAccumulator、json_float、数字 / 货币 / 模型名格式 |
| `rust/crates/ccusage-adapter-all/src/report.rs`、`types.rs`、`loader.rs` | `src/report.mjs`、`src/report/aggregate.mjs` | 统一日报 JSON、AllAccumulator、表格行与 Total、检测到的来源 |
| `rust/crates/ccusage-terminal/src/*` | `src/report/table.mjs`、`terminal.mjs`、`unicode-width.mjs` | 列宽与终端适配、换行截断、ANSI、标题框、unicode-width 0.2.2 字符宽度 |

上游代码与数据均为 MIT，版权与许可保留在仓库和打包产物中。

## 固定样本：147 项真实 ccusage 输出

`test/cases.mjs` 定义 49 组人工脱敏场景，每组运行 `UTC`、`Asia/Shanghai`、`America/New_York` 三个时区。`scripts/oracle.mjs` 对同一份输入运行真实 ccusage 与 usagelet，每项比较 by-agent JSON、普通 JSON、120 列无颜色表格（stdout 与 stderr）三份文本；设了 `costModes` 的场景另比较 `--mode calculate` / `--mode display` 的 JSON。预期文本存于 `test/golden.json.gz`，常规测试同时核对源码版与打包版，不依赖本机安装 ccusage。

v0.2 的 42 组覆盖 Claude 侧链 / 嵌套会话 / advisor / TTL 桶 / 别名 / 字段校验，Codex 累计重置 / 回退模型 / auto-review / headless / 去重 / 分叉 / compaction 排除，ZCode 旧表 / 补差 / 数值转换 / 跳过坏库，混合来源与多根目录。v0.3 新增 7 组费用场景：fast 倍率 + 1h 缓存 + 记录费用（三种费用模式）、边际分档与两段式长上下文、DeepSeek V4 生效期 / 高峰 / 周末、Codex 服务档位切换与无法识别的档位、config.toml 默认 fast、ZCode 各类 provider、别名与缺价模型。

结果：**147 项全部逐字节相同**。

## 本机真实日志

`scripts/compare.mjs`（`npm run compare`）用打包产物读取本机实时日志，与 ccusage 同参数输出逐字节比较（只比较 ccusage 也支持的三个来源）：

| 时区 / 范围 | 比较项 | 差异 |
|---|---:|---:|
| Asia/Shanghai、UTC、America/New_York，全量 | 94（每个时区 3 份 JSON + 7 种宽度 × 4 种表格，另加命令行 JSON 一项） | 0 |
| Asia/Shanghai，`--since 20260915 --until 20261017`，80 / 120 列 | 12 | 0 |

此时数据为 Claude 425 个日志（去重后 47,462 条）、Codex 24 个（769 条）、ZCode 一个数据库（7,460 条），全量 75 天，总费用 `5316.747708350002` 与 ccusage 完全相同。每个时区采集约 6.5 秒；不是跨机器的性能承诺。

## DeepSeek Harness

口径来源：`@deepseek-ai/dsh-token-meter` 的 tokenUsage 投影（usage-projection.js）、`dsh-session` 的分叉继承（`buildForkSeed`、`inheritedEventCount`）、`dsh-session-persistence-jsonl` 的代际选择与残帧规则、`dsh-session-format-v0-to-v1` / `v1-to-v2` 的历史流式块归组。本机桌面版为 0.2.1-rc.2，样本取自 deepseek-harness 提交 [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)。

核对方式都是“DSH 自己的代码算一遍、usagelet 算一遍”：用 `dsh-session-format-catalog` 把日志还原成当前格式，再用 tokenUsage 投影折叠。

| 验证 | 规模 | 差异 |
|---|---|---:|
| 仓库快照样本（补回 seq / time 信封后能被官方目录还原的全部） | 647 个会话：v0 14、v1 1、v2 152、v3 216、v4 264；578 个有用量，含重试 / 失败尝试、v0/v1 打包流式块、6 个继承了父会话用量的分叉子会话、10 个压缩摘要 | 0 |
| 同一批样本改写成拼接 Zstd 帧 | 647 | 0 |
| 按 DSH 目录结构摆放、多代际同目录，跑完整发现 + 去重 + 汇总 | 281 个会话（未压缩与压缩各一遍），总量与官方逐项相同 | 0 |
| 随机事件序列（含非法顺序、缺用量、部分缓存字段、重试与替换） | 5,000 组，对比官方折叠函数 | 0 |
| 本机真实会话 | 与 DSH 写下的投影缓存（tokenUsage）逐项相同 | 0 |

仓库里放了其中 17 个代表性样本（`test/fixtures/dsh/`，MIT）及官方算出的预期值，`npm test` 每次核对；`npm run test:dsh` 用本机桌面版自带代码重新生成预期值。

不计入的部分：会话标题、联网搜索等辅助 LLM 请求在日志里没有用量记录；压缩摘要请求有用量但 DSH 的 tokenUsage 不计，只在 `--extended` 下计入。

## 打包与平台边界

`npm run build` 将模块打包为单个 `dist/usagelet.mjs`（约 240 KB，含 deflate 压缩的价格快照），不复制 node_modules 或 JSON 文件到使用端，并生成独立 SHA-256 清单。

目前仅 macOS arm64、Node.js 22.23.2 实测。上述结论代表固定版本、已覆盖样本与本机数据的验证结果，不是对未来日志格式或任意平台的无条件承诺。线上同步链路尚未切换，未改动线上统计数据。
