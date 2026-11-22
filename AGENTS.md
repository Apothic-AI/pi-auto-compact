# AGENTS.md

Pi 扩展：在发 prompt 前按用量百分比预检（`input`），并在运行中工具批次结束后通过 Pi 可操作边界（`turn_end` + `CompactionEntryDraft`）自动压缩后无缝续跑；`tool_call` 只报状态。

源码只有 `extensions/auto-compact.ts`，无构建。peer `@earendil-works/pi-coding-agent >=0.99.0`（Node `>=22.19.0`）。类型和隔离 SDK 调度基线 1.6.0；真实 provider CLI 端到端基线仍是 0.99.1。

## 命令

```bash
npm run typecheck
npm test                 # smoke + integration，PI_CODING_AGENT_DIR 指临时目录，跑完自清理
pi -e .                  # 本地加载扩展
```

改 `peerDependencies` / `devDependencies` / `engines` 后必须 `npm install --package-lock-only`，否则 `npm ci` 会不同步。

## 发版

Agent 的 bash **不是 TTY**，不能代跑 `npm publish`。在本机真实终端做：

```bash
npm run typecheck && npm test
npm version patch|minor          # 会提交并打 tag
git push origin main --follow-tags
npm publish --otp=<验证器6位>    # 不要把 OTP/token 贴进对话或提交
npm view pi-auto-compact version
```

接着 `pi install npm:pi-auto-compact`。

要点（1.3.1 踩过）：

- `npm login` 只换会话，**不够发布**。开了 2FA 时 publish 会 EOTP。
- `--otp=123456` 是文档占位，必须用验证器当前 6 位。
- 非 TTY 下 npm 立刻抛 EOTP，不会打开浏览器；日志里的 auth UUID 会被打成 `***`，没法从输出里捞 URL。
- 要走网页授权：另开一个 cmd 窗口跑 `npm publish`（stdin/stdout 都得是 TTY），出现 URL 后回车开浏览器，完成 2FA。
- 不要用 `npm token create`（CLI 已不能建 granular token）。要免每次 OTP：npm 网站 Access Tokens → granular、Read and write、勾 Bypass 2FA，只写本机 `~/.npmrc`。

## 约定

- `ctx.compact()` 只允许在空闲 `input` 预检里走 `compactAndWait`。**禁止**在 `tool_call` / `turn_end` / `agent_end` 等运行中回调调 `ctx.compact()`：它先 `abort()`，整轮作废、prompt 丢失。
- 运行中压缩在 `turn_end` 里做：仅当 `outcome === "completed"` 且将续跑（`toolResults.length > 0 || pendingMessages.length > 0 || event.continue`）且未已有 compaction draft 时，用 `prepareBoundaryCompaction(event.context.contextEntries, ...)` 切分（不切在 `toolResult` 上），调 Pi 的 `compact()` 经 `ctx.modelRegistry.streamSimple` 生成摘要，返回 `{ entries: [...event.entries, { type: "compaction", ... }] }`。**绝不设 `continue: true`**（省略 `continue` 即可保留原调度续跑，否则无工具时会死循环）。失败时降级放行继续执行，不打断运行。
- 对齐阈值（可选 opt-in）：`/compact-threshold align on|off` 写 `~/.pi/agent/settings.json` 的 per-model `reserveTokens`（必须 `/reload` 才对 Pi 自身 `prepareNextTurn` 生效）。只动自己写过的 `reserveTokens` 键，`align off` / `reset` 不得误删用户的 `keepRecentTokens`；用户自己的 reserve 跳过。注：Pi `>=1.4.0` 中 `reserveTokens` 只控制触发点，摘要上限用模型 `maxTokens`（不再是 `0.8×reserve`）。
- `tool_call` 只读 usage、只报状态，不 block、不压缩；`usage` 为空时清状态。`session_compact` 也清状态。
- 不要 `sendUserMessage` 重发原 prompt（`input` 在 `prompt()` 内，会递归）；返回 `{action:"continue"}`。
- 异步回调：`sessionGeneration` 守护 + UI try/catch。`input` 预检软错误（Nothing to compact / Already compacted）放行；硬错误拦下，↑键召回重发。
- 不做压缩超时兜底（1.2.2 裁决：当前 before_compact 都同步返回，路径不可达）。
- 配置 `~/.pi/agent/pi-auto-compact.json`（`getAgentDir()` / `PI_CODING_AGENT_DIR`）：`threshold` 区间 `[30, 99)`，`alignPiThreshold` 默认 false，`alignedReserveTokens` 记账。越界回退上一有效值；读写热加载；`updateJsonFile` 原子合并写。

## 验证与边界

改动后：`npm run typecheck` + `npm test`（`test/smoke.ts` + `test/integration.ts`）。`test/integration.ts` 隔离 cwd 和 agentDir，仅替换模型响应与摘要生成，无网络调用；覆盖低于阈值不压缩、不开 `align on` 时的 `turn_end` 自动压缩并续跑、同批次兄弟工具先完成再压缩、`input` 预检先压缩再发送、`align on/off` 保留 `keepRecentTokens` 与 `/reload` 边界。真实 provider 端到端用**隔离 cwd + 隔离 `PI_CODING_AGENT_DIR`** 的 `pi -p`（`pi -c` 会接同目录最新 session）。升级 pi 后复测 `ctx.compact()` / `input` / `tool_call` / `turn_end` boundary draft / `shouldCompact`。

不预检：无 `contextWindow`、steer/followUp（由运行中 `turn_end` 与 Pi 兜底）、skill/template 展开后的膨胀（Pi 兜底）。`tool_call` 不预测尚未产生的工具结果。同一 assistant 的工具批次、单个 codemode 内的嵌套调用不逐个压缩；需要检查点时拆成顶层批次。

端到端测试用 `openai-codex/gpt-5.6-luna`（`deepseek` 已欠费）。

## 当前

准备发布 `1.4.0`。开发依赖已对齐 npm latest pi 1.6.0，已补齐运行中 `turn_end` 自动压缩续跑及代码审校修复，类型检查与 40 条测试通过。未重跑真实 provider CLI 端到端；`alignPiThreshold` 仍默认关闭，不改用户全局配置。
