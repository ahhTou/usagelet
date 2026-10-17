# 兼容性验收

> 2026-10-18 · v0.2.1 · 默认模式固定对齐 ccusage 20.0.21

## 对齐契约

验证对象为 Claude Code、Codex、ZCode 的 `daily --json --by-agent -O`：逐日、逐 Agent、逐模型的四项 token，及日、Agent、全局总量。费用估算、终端展示和其他命令不在实现范围内。

上游版本固定为 tag `v20.0.21`，提交 [`3c5556a775ebcf1e59844d4283c8c5b30529c290`](https://github.com/ccusage/ccusage/tree/v20.0.21)。本机基线程序打印 `ccusage 20.0.21`，oracle 脚本先检查版本再运行。后续上游升级必须更新契约并重跑对比，不能沿用当前结论。

**v0.1.0 的“排除新增统计、统一展示名后相同”不作为验收依据。** v0.2.0 的默认模式直接比较两边输出，差异必须为零；扩展能力通过显式 `--mode extended` 使用。

## 源码逐项映射

路径均相对于上述上游版本。

| 上游 | usagelet | 核对内容 |
|---|---|---|
| `rust/adapters/claude/src/daily.rs` | `src/adapters/claude.mjs` | 读取、字段有效性、去重键、完整快照选择、主线优先、advisor |
| `rust/adapters/claude/src/lib.rs`、`paths.rs` | Claude 适配器、`src/json.mjs`、`collect.mjs` | AgentProgress、null 约束、缺省值、会话路径及多个主目录 |
| `rust/adapters/codex/src/parser.rs`、`types.rs` | `src/adapters/codex.mjs`、`compat.mjs` | 累计差分、整数别名及字符串、headless、时间戳与模型回退 |
| `rust/adapters/codex/src/codex-auto-review-fallbacks.json` | 同名参考数据文件 | 使用上游固定发布日期表，不在比较时改名 |
| `rust/adapters/codex/src/paths.rs`、`replay.rs`、`loader.rs`、`aggregate.rs` | Codex 适配器、`collect.mjs` | 活动日志优先、分支前缀 / 分叉时间、重写时间突发、跨文件事件去重 |
| `rust/adapters/zcode/src/loader.rs`、`parser.rs` | `src/adapters/zcode.mjs` | 旧 / 新表、完成状态、缓存拆分、SQLite 数值转换与用量 id 去重 |
| `rust/crates/ccusage-core/src/utils.rs`、`model_aliases.rs` | `compat.mjs`、`aggregate.mjs` | 总量补差、配置别名、四项和与记录总量的区别 |

上游代码均为 MIT，版权与完整许可保留在仓库和打包产物中。

## 固定样本：126 项真实上游输出

`test/cases.mjs` 定义 42 组人工脱敏场景，每组运行 `UTC`、`Asia/Shanghai`、`America/New_York` 三个时区。`scripts/oracle.mjs` 对同一份输入运行真实 ccusage 与 usagelet，比较完整记录集合和全局总量；`test/golden.json` 保存 ccusage 的真实预期，常规测试不依赖本机安装 ccusage。

覆盖 Claude 侧链与嵌套会话、缺 id / requestId、advisor、无模型记录、详细 TTL 桶、fast / 用户别名、无效字段 / null / 重复字段 / 非整数字面量；Codex 累计重置、缺模型回退、auto-review 发布边界、headless 多格式、字符串计数、缓存钳制、跨文件 / 别名后的重复、活动与归档优先、父日志缺失 / 不匹配、分叉截止、压缩及独立 compaction 的基线排除规则；ZCode 旧表、补输出 / 额外总量、负数 / 小数转换、缺 `model_usage` 表或必需列时跳过该库而保留 Claude 结果；以及混合来源和多个主目录。

结果：**126 项直接对比零差异**。测试过程中发现并修正了 ZCode SQLite 实际按整数读取时截断小数的语义差异。

另保留 18 项扩展模式、压缩读取、损坏数据和单文件分发测试，以及 7 项 v0.2.1 回归修复测试。共 **151 项测试通过**。

## 冻结本机日志：六组直接比较（v0.2.0）

为避免活跃会话在两次采集之间增长，先在本机临时目录冻结日志：只复制日志文件，ZCode 使用 SQLite 只读连接的 backup API 建立一致性副本。未复制或读取凭据。两边均从这份快照读取，快照不提交、不上传，完成后删除。

快照包含 Claude 416 个普通日志、Codex 23 个普通日志和 ZCode 的一个数据库。基线不读取压缩归档，因此本次契约范围内不复制压缩文件。这是两边一致的数据发现规则，不是比较后过滤差异。

| 时区 | 范围 | 天数 | 比较记录数（不含全局总计） | 差异 |
|---|---|---:|---:|---:|
| UTC | 全量 | 72 | 324 | 0 |
| Asia/Shanghai | 全量 | 75 | 338 | 0 |
| America/New_York | 全量 | 73 | 321 | 0 |
| UTC | 2026-09-01 至 2026-10-01 | 31 | 163 | 0 |
| Asia/Shanghai | 同上 | 31 | 169 | 0 |
| America/New_York | 同上 | 31 | 161 | 0 |

冻结时 Claude 去重后 46,646 条、Codex 730 条、ZCode 7,460 条。源码模块版每组采集约 6–7 秒；不是跨机器的性能承诺。日、来源及模型行之外，最终检查还包含全局四项与总 token。

## v0.2.1 回归修复

v0.2.0 回归测试发现的偏差，逐项修复并补测试（`test/regression.test.mjs`，ZCode 场景另进固定样本）：

| 问题 | 修复 |
|---|---|
| ZCode 库缺 `model_usage` 表或必需列时整次运行退出 1，Claude / Codex 结果全部丢失；ccusage 同场景正常输出 | 按上游 `rust/adapters/zcode/src/loader.rs`：打不开、结构不符、查询失败都只跳过该库（逐行读取中断保留已读部分）。上游只写调试日志，usagelet 另记 `zcode_schema` / `zcode_unreadable` 警告。扩展模式同样处理 |
| `collect()` 不校验日期，`since: '20260915'` 静默返回 0 天且 `complete: true` | 日期规范化与校验从 `cli.mjs` 移到 `collect()`，库与命令行一致 |
| 默认模式 `--agent deepseek` 仍标 `compatibility: ccusage@20.0.21` | 选中契约外来源时 `compatibility` 为 `null` |
| `--source zcode=<目录>` 只报 `disk I/O error` | 直接报错，带路径并提示要指向 `db.sqlite` 文件 |
| `--agent claude,` 报「未知来源 」 | `--agent` 去掉空白与空项，全空时报缺少值 |
| README 称会提示已发现的 JSON 问题 | 改为如实说明：默认模式 Claude 只解析含 `"usage":{` 的行，其他损坏行不提示 |

修复后用打包产物（`--bundle`）对本机实时日志直接比较，截至前一天以避免当日会话增长：

| 时区 | 范围 | 天数 | 比较记录数 | 差异 |
|---|---|---:|---:|---:|
| Asia/Shanghai | 全量至 2026-10-17 | 74 | 332 | 0 |
| UTC | 同上 | 72 | 325 | 0 |
| America/New_York | 同上 | 73 | 322 | 0 |
| Asia/Shanghai | `--since 20260915 --until 20261017` | 29 | 163 | 0 |

此时 Claude 418 个日志、Codex 23 个、ZCode 一个数据库。

## 打包与平台边界

`npm run build` 将模块打包为单个 `dist/usagelet.mjs`，不复制 node_modules 或 JSON 文件到使用端。在干净目录只放打包后的 JS 即可执行；生成独立 SHA-256 清单。

目前仅 macOS arm64、Node.js 22.23.2 实测。上述结论代表固定版本、已覆盖样本和冻结本机数据的验证结果，不是对未来日志格式或任意平台的无条件承诺。异常时应保留诊断，不静默宣称对齐。

DeepSeek 保留原有扩展适配，参考提交 [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)。此前已用官方解码器独立复核 257 帧 / 52 条用量；它不纳入 ccusage 三来源兼容契约。Qoder 暂缓。

本次没有替换线上同步链路、修改线上用量、用户、令牌或配置，仅发布静态构建产物。
