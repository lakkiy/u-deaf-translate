# Project guidance

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.
DO NOT MODIFY THE 8 RULES BELOW.
If you think a rule is wrong or missing, stop and ask the user explicitly.
KEEP THIS FILE UNDER 200 LINES TOTAL.

## Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 6 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 7 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 8 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

## 文档维护

每当做了非显然的决定、修了 surprising 的 bug、加了浏览器/API 层面的 workaround、或改了工具链，**主动调用 `update-project-docs` skill**（位于 `.claude/skills/update-project-docs/SKILL.md`），把变化同步到：

- `docs/decisions.md` — 设计决策与技术选型（"为什么这么做"）
- `docs/pitfalls.md` — 已踩过的坑（"现象 / 真相 / 修复"）

不要等用户提醒。但简单 bug、改名、refactor 这类不必记。

## Commit 风格

GNU Emacs / ChangeLog 风格。需要时调 `emacs-commit` skill。不加 `Co-Authored-By` 等 trailer，除非用户明确要求。

## 沟通语言

简体中文。
