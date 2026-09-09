# dsh-agent

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)的**交互式 ACP v2 桥**:把 dsh agent 暴露成可被桌面/编辑器客户端托管的聊天后端——逐 token 流、运行态直报(`state_update`)、权限桥、取消。树外插件形态,不 fork dsh,依赖钉死 npm 精确版本。

由 [ALwith](https://github.com/ALwith-ai) 维护;**ALwith Desktop 是它的参考客户端**(dsh 的桌面端形态)。上游的 ACP 实现是刻意的 automation-only(仅新会话、只发已提交输出),本桥补齐交互式一侧。

> 状态:developer preview。覆盖 `session/new` + prompt + 流式 + 状态直报 + cancel + `session/resume`(live-first 接续、JSONL 持久化冷恢复、客户端 `replayFrom` 游标历史回放)+ 沙箱优先工具面与升级审批 + 会话中切模型(`session/set_config_option`)+ LLM 会话标题(先落确定性截断,后台一次生成升级)+ 全部 dsh 预设(`standard` / `minimal` / `anchored` / `code` PTC,跑在 Bun 补丁版官方 worker 运行时上 / `cordis` 创造模式,vm 域动态插件工具组 + 随捆 `cordis-plugin-development` skill)+ 面向宿主的 `plugins` / `sessions` 管理 CLI + 多厂商席位(`ALWITH_DSH_PI_PROVIDERS`:pi-ai 目录路由 —— openai / anthropic / google / xai / … —— 与 DeepSeek 适配器并挂)。

## 结构

| 文件 | 职责 |
|---|---|
| `src/bridge.ts` | ACP v2 服务器插件(改编自上游 automation-only v1 桥,MIT) |
| `src/codec.ts` | 线格式纯转换(改编自上游 codec) |
| `src/plugins.ts` | 插件清单:组合面即数据(逐预设 roster、核心行保护、用户覆盖) |
| `src/compose.ts` | 按清单组合运行时(不用 dsh loader/profile——组合确定性,Bun 可跑) |
| `src/plugins-cli.ts` | `plugins` 子命令:无活会话即可列出与开关插件 |
| `src/sessions-cli.ts` | `sessions` 子命令:经 dsh 自家 persistence 检查会话日志 |
| `skills/` | 随预设捆入的 skill(vendor 自 dsh cordis 预设,MIT) |
| `src/main.ts` | stdio 入口,供宿主 spawn |

## 运行

需要 Bun（已用 1.4.0 验证）；sidecar 不支持以 Node.js 运行。在仓库检出目录中，使用 `bun install --frozen-lockfile` 安装已锁定的依赖集合。

```sh
DEEPSEEK_API_KEY=… bun src/main.ts   # stdio 上的 ACP v2 服务器
bun test                              # mock 适配器协议测试,不打真模型
```

`session/resume` 语义:`replayFrom` 省略 = 只恢复上下文;`{ type: "start" }` = 整段对话重放为 `session/update` 帧。每个进程只挂一个持久化 provider,由 `ALWITH_DSH_PERSISTENCE` 选择:`dsh`(默认)把 dsh 自己的 JSONL 日志存在 `$ALWITH_DSH_SESSIONS_ROOT`(默认 `~/.dsh-agent/sessions`);`alwith` 把每个会话存成 ALwith 会话记录(`$ALWITH_DSH_PROJECTS_DIR/<项目键>/<sessionId>.jsonl`,明文 JSONL,兼容 Claude Code 消息,dsh 事件原样保留)。选 `alwith` 时 `session/resume` 也能接续 ALwith CLI 写的记录:消息、工具调用与结果重建成 dsh 事件,思考块不进模型上下文。两个 provider 都过上游持久化契约测试。

轮次结束（包括取消）在报告 `idle` 前等待 Agent 停稳及会话持久化检查点。忽略取消信号的工具可能延迟这一边界。取消尚未结束时拒绝新提示；活跃轮次中的空提示不会结束该轮。`session/close` 在释放 Agent 前排空待写事件，并取消后台标题任务。模型与检查点失败报告 `_error`，宿主据此保持失败待处理。

提示会等待已有切换结束；切换期间关闭会话会阻止替代 Agent 发布。切换失败后，有持久化日志的会话可通过 `session/resume` 恢复；尚无日志的空会话需要重新调用 `session/new`。

取消与关闭会主动丢弃待处理输入。没有私有的历史注入扩展:接续走 `session/resume`,由挂载的持久化 provider 提供。适配器必须响应中止信号，否则取消、关闭和退出都可能停滞。宿主可以设置进程退出期限，但强制终止可能丢失尚未刷盘的日志，恢复后历史可能不完整。后台标题收到中止信号后不会阻塞关闭。保留标准 ACP 错误码；面向人的错误消息不是稳定的机器解析接口。

在仓库检出目录中运行 `python3 scripts/verify-package.py` 可在本地验证打包产物。发布流程和验证器均使用 `npm pack` 将 `bun.lock` 纳入 tarball。验证器要求解包后的锁文件与仓库字节一致并记录 SHA256，执行生产依赖冻结安装（可能需要网络及原生构建环境），再通过声明的可执行入口对五个预设执行无需凭据的 ACP 检查。超时保护属于验证器，不属于桥接协议。日志和产物保留在输出路径；安装失败不会被绕过。`packageManager` 字段记录已验证的工具链，不强制运行时版本。发布包自带 Desktop 安装所需的锁文件。这不证明跨平台或真实模型厂商兼容性。当前锁定集合存在 Cordis peer 警告（`4.0.1` 与上游要求的 `^4.0.2` 不匹配）；已测试路径通过，但整套依赖对齐需要另行决策和验证。

## 插件

各预设的组合面在代码里写死(确定性),但用户保有 dsh 的两个自由度——逐插件开关与逐插件配置——经覆盖文件(`$ALWITH_DSH_PLUGINS_FILE`,默认 `~/.dsh-agent/plugins.json`)生效;spawn 时读取,改动作用于新会话:

```sh
bun src/main.ts plugins list --preset standard   # 该预设的全部行,JSON
bun src/main.ts plugins set tool-web disabled    # 先校验再落盘
```

```json
{ "disabled": ["tool-web"], "config": { "bash-sandbox": { "timeoutMs": 120000 } } }
```

核心行(session、llm、沙箱、审批…)不可停用;停用某行会让另一启用行的 `requires` 落空时,拒绝并给出确切改法——两者都在写盘前炸清楚。`config` 条目与该行默认配置浅合并。

## License

[MIT](LICENSE);改编自上游 `@deepseek-ai/dsh-acp` 的部分见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
