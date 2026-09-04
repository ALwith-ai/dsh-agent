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

```sh
DEEPSEEK_API_KEY=… bun src/main.ts   # stdio 上的 ACP v2 服务器
bun test                              # mock 适配器协议测试,不打真模型
```

`session/resume` 语义:`replayFrom` 省略 = 只恢复上下文;`{ type: "start" }` = 整段对话重放为 `session/update` 帧。会话日志在 `$ALWITH_DSH_SESSIONS_ROOT`(默认 `~/.dsh-agent/sessions`)。

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
