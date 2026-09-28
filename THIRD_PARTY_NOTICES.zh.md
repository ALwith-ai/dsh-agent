# 第三方声明

[English](THIRD_PARTY_NOTICES.md) | 中文

`src/bridge.ts` 与 `src/codec.ts` 的结构改编自
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
`@deepseek-ai/dsh-acp` 包(automation-only ACP v1 桥),原始版权与许可如下:

```
MIT License

Copyright (c) 2026 DeepSeek
```

运行时依赖 `@deepseek-ai/dsh-*`(MIT)与 `@agentclientprotocol/sdk`(Apache-2.0)
以 npm 包形式引用,各自许可见其发行物。

---

`skills/cordis-plugin-development/` 逐字 vendor 自
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(MIT),
路径 `packages/preset/agent-preset/skills/cordis-plugin-development/`。

---

`src/vendor/anchored-tool-bootstrap.mjs` vendor 自
[dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)(Apache-2.0)的
`dsh-liangshen` 包,其上游为
[xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
(MIT)。该文件保留其上游许可;溯源见文件头。
