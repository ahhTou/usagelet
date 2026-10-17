# 验证与来源记录

> 2026-10-18 · v0.1.0 · 仅 macOS 实测

## 参考版本

- ccusage v20.0.21：本机已安装版本，也是旧同步链路的统计基线；已获取对应 tag 源码。
- ccusage 主分支提交 [`c1eb44896082d5bf0915bae578eb5b14c031f49f`](https://github.com/ccusage/ccusage/commit/c1eb44896082d5bf0915bae578eb5b14c031f49f)：参考 Claude 去重、Codex 压缩 / compaction 规则、ZCode 只读 SQLite 与缓存拆分。该版本核心是 Rust；usagelet 是 JS 实现，不调用其二进制。
- DeepSeek Harness 提交 [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)：参考 session 持久化格式、Zstd 帧结构和 token-meter 快照 / 重试规则。

上游均为 MIT。仓库与单文件保留相关版权及许可。测试样本为人工构造的脱敏记录，不包含本机对话、凭据或用户路径。

## 自动测试

运行 `node --test test/*.test.mjs`。当前 18 项通过，覆盖：

- Claude 同一会话跨文件去重、不同会话隔离、完整快照选择、侧链重放、TTL 缓存桶、advisor 模型归属。
- Codex 累计差分、重复快照、模型切换、缓存互斥、普通 / 压缩副本、分支前缀和父会话缺失。
- Codex local / remote compaction，以及 compaction 标记前后顺序不同的去重。
- ZCode 只读访问、仅已完成请求、缓存拆分。
- DeepSeek 最高代际、拼接 Zstd 帧、stream 用量、快照替换、重试累加及种子历史警告。
- 缺失值、坏 JSON、未知版本、损坏 / 截断压缩文件、时区、日期过滤和安全整数溢出。
- 将单个 `.mjs` 复制到干净目录直接运行，不依赖 package.json 或 node_modules。

## 本机真实数据验证

环境为 macOS arm64、Node.js 22.23.2，默认四个来源全量读取。一次完整运行约 **4.5 秒**，结束时 RSS 约 **200 MiB**；这是本机单次测量，不是跨平台性能承诺，运行期间日志会继续增长。

| 来源 | 扫描文件 | 去重 / 合并后用量记录 |
|---|---:|---:|
| Claude Code | 416 | 46,646 |
| Codex（含归档和压缩） | 352 | 12,699 |
| ZCode | 1 个 SQLite | 7,460 |
| DeepSeek Harness | 4 | 52 |

覆盖 155 天。数值是验证时快照，不固定在代码或测试中。

### 与旧 ccusage 的差异

以 `ccusage daily --json --by-agent -O --timezone Asia/Shanghai` 为基线，比较日期、Agent、模型及四项 token：

- Claude：同一快照中所有汇总行四项计数一致。对账过程中确认必须按会话隔离去重，并优先读取 `cache_creation` 的详细 TTL 桶。
- ZCode：各汇总行四项计数一致。
- Codex：v20.0.21 不读 `.zst`，usagelet 会读，因此完整历史应有增量。该版本也未统计独立 compaction 用量；排除新增 compaction 逻辑、统一其 `codex-auto-review → gpt-5.5` 展示映射后，2026-10-18 之前的未压缩历史汇总逐项一致。这个排除操作仅用于对账，不是发布版功能；发布版保留原始标识并计入已确认的 compaction 用量。当前日会继续产生新记录，不以不同时间点的当日值做相等断言。

### DeepSeek 独立复核

使用 DeepSeek 官方源码中的 `scanZstdFrames` / `decompressZstdFrame` 独立解码四个本机会话，共 **257 帧**。按其结算用量规则复核得到：

| 项目 | token |
|---|---:|
| 不含缓存输入 | 90,992 |
| 输出 | 38,095 |
| 缓存写入 | 0 |
| 缓存读取 | 2,053,632 |
| 合计 | 2,182,719 |

与 usagelet 的 52 条用量汇总一致。只用 Node 22 一次性解压整个拼接文件会只得到首帧，不能拿它当完整日志验证结果；usagelet 为 `.zstd` 实现了逐帧读取。

## 发布与边界

v0.1.0 没有修改服务器用量数据、令牌、配置或现有同步链路。发布对象只有静态 JS 文件与 SHA-256 校验清单。

尚未验证：Linux / Windows、DeepSeek 每个历史格式的真实安装、带种子历史的去重、缺父日志或时间被重写的 Codex 分支的完整性。Qoder 按用户要求暂缓。以上情况不应被表述为已经全面支持。
