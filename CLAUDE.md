# Project guidance

## 文档维护

每当做了非显然的决定、修了 surprising 的 bug、加了浏览器/API 层面的 workaround、或改了工具链，**主动调用 `update-project-docs` skill**（位于 `.claude/skills/update-project-docs/SKILL.md`），把变化同步到：

- `docs/decisions.md` — 设计决策与技术选型（"为什么这么做"）
- `docs/pitfalls.md` — 已踩过的坑（"现象 / 真相 / 修复"）

不要等用户提醒。但简单 bug、改名、refactor 这类不必记。

## Commit 风格

GNU Emacs / ChangeLog 风格。需要时调 `emacs-commit` skill。不加 `Co-Authored-By` 等 trailer，除非用户明确要求。

## 沟通语言

简体中文。
