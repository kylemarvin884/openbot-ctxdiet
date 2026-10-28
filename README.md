# ctxdiet

**找出吃掉 agent 上下文的工具输出。** 一条命令读完本地会话记录，告诉你「哪几次调用把 context 塞满了、下次怎么截断」，最后给一段可以粘进 `AGENTS.md` 的规则。

零依赖、不联网、不调模型、不上传 transcript。

```bash
git clone https://github.com/kylemarvin884/openbot-ctxdiet
cd openbot-ctxdiet
node src/cli.mjs scan test/fixtures/fat-session.jsonl
```

```text
ctxdiet 0.1.0
session  test/fixtures/fat-session.jsonl  (claude-code)
calls    7  |  tool output 108.4k chars (~27.1k tokens, estimate)
fat      5 calls (71%) produced 94% of the output  |  fat = >8.0k chars, no bound

by class
  duplicate        1 calls   29.6k chars   27%  重复输出
      → 同一份输出不要第二次整段取回：记住结论，或写进文件再引用。
  file-dump        1 calls   29.6k chars   27%  整文件读取
      → 先 grep -n 定位符号，再用 offset/limit 读 ±40 行；不要整读大文件。
  log-dump         1 calls   19.4k chars   18%  日志整段
      → 只取尾部 40 行或换 --reporter=dot；把汇总数字带回，不要贴全文。
  tree-dump        1 calls   14.2k chars   13%  目录全量列举
      → 限制深度，排除 node_modules / dist / .git 后再列。
  cat-dump         1 calls    9.1k chars    8%  cat/Get-Content 整文件
      → 命令里就限制输出：head/tail/Select-Object -First，或直接 grep。

top calls
   1   29.6k chars  file-dump    src/app.tsx  line 1
   2   29.6k chars  duplicate    src/app.tsx  line 13
   3   19.4k chars  log-dump     npm test  line 3
   4   14.2k chars  tree-dump    ls -R src  line 5
   5    9.1k chars  cat-dump     cat package.json  line 7

avoidable 94% of tool output is an upper bound: it assumes every fat call had a bounded alternative.
tokens    ~25.5k tokens would not have been sent (chars/4 estimate).
```

`npm run demo` 会同时跑上面这份「脏会话」和一份「干净会话」，干净会话的结果是 0 fat。

## 为什么做这个

我先做了一个反方向的工具：找「白做的工具调用」（重复读、重复命令、重试风暴）。在本机 40 份真实 Codex 会话上跑完，**39 份是 0%，中位数 0%**——也就是说「重复调用」不是主要浪费，那个指标是噪音，砍了。

同一次测量里另一件事很清楚：**14% 的调用产生了 53% 的工具输出**。真正吃 context 的是少数几次「整段 dump」，而不是重复。

本机实测（`~/.codex/sessions/2026/10`，Codex rollout，302 个会话、2026-07 至 2026-10）：

```text
sessions 302  |  compacted 300x
calls    24.5k  |  tool output 135.4M chars (~33.9M tokens, estimate)
fat      3.4k calls (14%) produced 53% of the output  |  fat = >8.0k chars, no bound

by class
  command-dump  1780 calls   37.8M chars  28%  大段命令输出
  log-dump      1498 calls   32.7M chars  24%  日志整段
  cat-dump        56 calls  894.3k chars   1%  cat/Get-Content 整文件
  tree-dump       21 calls  552.9k chars   0%  目录全量列举
  duplicate        9 calls   53.8k chars   0%  重复输出
```

这是**一台机器、一个 harness 的历史**，不代表你的项目。你可以用自己的目录复核，数字应该不一样。

## 它怎么算

对每次工具调用，只用它在 transcript 里的结果文本：

1. 字符数 ≥ `--threshold`（默认 8000 字符，约 2k tokens）才算 fat；
2. 已经自己限界的调用不算：`Read` 带 `offset/limit`、命令里有 `| tail` / `head` / `Select-Object -First` / `--oneline` / `sed -n` 等；
3. 剩下按输出形态归类，每类固定一条修法；
4. 同一份输出再次出现，记为 `duplicate`（无论哪个工具）；
5. 汇总：fat 调用占比、fat 输出占比、按类分布、单条 top calls、被反复整取的 target。

「avoidable」是**上界**：它假设每次 fat 调用本来都能用更小的输出完成。真实收益取决于任务，报告里不把它写成已经省下的钱。

## 用法

```bash
# 单个会话
node src/cli.mjs scan ~/.codex/sessions/2026/10/15/rollout-....jsonl.zst

# 整个目录（递归，跳过隐藏目录和 node_modules）
node src/cli.mjs scan ~/.claude/projects/-Users-me-repo/

# 机器可读
node src/cli.mjs scan <path> --json

# 追加一段可粘进 AGENTS.md / CLAUDE.md 的规则
node src/cli.mjs scan <path> --rules

# 当门禁用：可避免 token 超过 20k 就失败
node src/cli.mjs scan <path> --max-tokens 20000
```

| 选项 | 作用 |
| --- | --- |
| `--threshold <chars>` | 多长的输出算 fat，默认 8000 |
| `--max-tokens <n>` | 可避免 token 估算超过 n 时 exit 1 |
| `--top <n>` | 列出多少条，默认 8 |
| `--json` | 输出 JSON（含每个会话的分类、top、重复 target） |
| `--rules` | 追加 AGENTS.md 规则片段 |

退出码：`0` 正常，`1` 超阈值或输入不可读/没有工具调用，`2` 参数错误。

## 支持的格式

| 格式 | 说明 |
| --- | --- |
| Claude Code JSONL | `~/.claude/projects/<project>/<session>.jsonl` |
| Codex rollout | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`（自动解压，需要 Node ≥ 22.15） |
| OpenAI 风格 | `{role, tool_calls:[{function:{name, arguments}}]}` |
| 通用 | `{tool, input, result}` 每行一条 |

不认识的行走跳过并计入 `warnings`，不猜内容。

## 三个真实用例

1. **长任务会话复盘**：一个 8k 次工具调用的会话里，601 次日志整段占了 40% 的输出。先改这一条，比换模型便宜。
2. **给团队定输出纪律**：`--rules` 生成的片段直接进 `AGENTS.md`，把「单次输出 ≤ 8k 字符、日志只取尾部」变成常驻规则，而不是靠人提醒。
3. **接入 CI / 会话钩子**：`--max-tokens 20000` 让「这次会话把 context 灌爆了」变成一个非零退出码。

## 边界

- **不估算美元**：价格表会过期，报告只给字符数和 chars/4 的 token 估算（明确标 `estimate`）。
- **不评价回答质量**：它只量输入体积，不判断内容对不对。
- **`bounded` 是启发式**：靠 `offset/limit`、`| tail` 这类模式识别，不解析 shell AST，可能漏判。
- **不读 transcript 之外的文件**：不解压到磁盘、不改写 transcript、不联网。
- **不虚构数据**：README 里的数字都带来源和日期；除此之外的「节省比例」都是上界估算。

## 开发

```bash
npm test        # 24 个测试，node:test，无依赖
npm run demo    # 两个 fixture 的完整输出
```

MIT License。
