# Third-party notices

English | [中文](THIRD_PARTY_NOTICES.zh.md)

The structure of `src/bridge.ts` and `src/codec.ts` is adapted from the
`@deepseek-ai/dsh-acp` package (the automation-only ACP v1 bridge) of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), whose
original copyright and license follow:

```
MIT License

Copyright (c) 2026 DeepSeek
```

Runtime dependencies `@deepseek-ai/dsh-*` (MIT) and `@agentclientprotocol/sdk`
(Apache-2.0) are consumed as npm packages; see their distributions for the
respective licenses.

---

`skills/cordis-plugin-development/` is vendored verbatim from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT),
path `packages/preset/agent-preset/skills/cordis-plugin-development/`.

---

`src/vendor/anchored-tool-bootstrap.mjs` is vendored from
[dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) (Apache-2.0), package
`dsh-liangshen`, itself derived from
[xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
(MIT). The file retains its upstream licenses; see the provenance header inside it.
