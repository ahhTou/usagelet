# DSH 会话日志样本

来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 提交
`687f282e8625c6b8d11ff58211a90524be2e4317` 的快照测试样本（MIT，许可见同目录 `LICENSE`），
覆盖 v0–v4 各代格式、重试、分叉继承、压缩摘要、模型切换与 v0/v1 打包流式块。

上游快照为了可复现，去掉了每行的 `seq` / `time` 信封，并把会话 id、cwd 等换成占位符。
放进这里之前做了“补全”：按行补回连续的 `seq`、递增的 `time`（打包行补 `seq0` / `time0`），
`{{cwd}}` 换成 `/workspace`，`{{session:N}}`、`{{parent}}` 等身份占位按快照目录换成唯一 id，
`"tools":"{{tools}}"` 在 v3+ 去掉、v2 及以前换成空数组。除此之外事件内容保持原样。

`expected.json` 是用 DSH 自己的代码算出的预期值：经 `@deepseek-ai/dsh-session-format-catalog`
把各代日志还原成当前格式，再用 `@deepseek-ai/dsh-token-meter` 的 tokenUsage 投影折叠。
`all` 是全部事件，`own` 是继承前缀之后的自有事件，`compaction` 是自有事件里压缩摘要请求的用量。
重新生成见 `scripts/dsh-oracle.mjs`。
