# 正文识别算法设计文档

本文档描述 `src/page-content.ts` 的 `findContentRoot` + `collectParagraphs` 两个函数，
即整页沉浸式翻译的正文识别算法。目标读者是以后要修改这个算法的人——写到能脱离代码
复现的程度。

## 1. 定位与取舍

这是为"沉浸式翻译"服务的正文识别，**不是** Readability.js 式的"正文提取"：

- **评论/讨论区也是要翻译的内容**。Readability 想抽出单一的"文章正文"容器，会把
  评论区当噪声丢弃；这里恰恰相反——论坛/新闻评论对用户同样有阅读价值，所以负面词表
  里刻意不含 `comment`，`header`/`menu`/`nav` 这类也不列入排除词（怕误伤 article-header
  里的标题、评论区常见的 `nav` 结构）。
- **宁可多收可读内容、不可丢正文**。两种错误不对等：漏掉一段正文用户会发现"这段怎么
  没翻"，多收几行元数据/推荐位噪声顶多是"多翻了一行没用的"。所以规则设计上系统性地
  偏向"不确定就放行"。
- **零依赖、独立于翻译状态**。整个文件不 import 任何外部库（包括不 import
  Readability.js——70KB+ 对一个浏览器扩展的 content script 太重），也不感知"这段是否
  已翻译"这类运行时状态；翻译状态（`data-tnyl-translated` 标记）由调用方
  `page-translator.ts` 在拿到 `collectParagraphs` 的结果之后自己过滤。这样这个模块可以
  完全脱离扩展环境，用 linkedom 之类的纯 DOM 实现单独跑评测（见第 4 节）。

## 2. 算法总览

两步：`findContentRoot()` 圈出一个"正文容器"，`collectParagraphs(root)` 在容器内挑出
候选段落元素。

### 基础定义

- **PARAGRAPH_TAGS（候选段落标签）**：`p / li / h1-h6 / blockquote / dd / dt / figcaption`；
  另有 **div / td 叶子块候选**（细节见 2.3 第二步）。
- **EXCLUDE_TAGS（自身或任一祖先命中即整体排除）**：
  - `PRE / CODE / SCRIPT / STYLE / NOSCRIPT` —— 代码与脚本不翻；
  - `NAV / HEADER / FOOTER / ASIDE / MENU` —— 页面骨架，非正文；
  - `BUTTON / SELECT / TEXTAREA / INPUT / SUMMARY` —— 控件。`SUMMARY` 是 `<details>`
    的折叠触发标签，本质是控件标注而非正文——加入的原因是 MDN 的兼容性徽章
    `<summary><div>Baseline Widely available</div></summary>` 会被 div 叶子块规则
    误收（`<details>` 本身不在排除表里，展开后的正文不受影响）；
  - `A` —— 祖先是链接 ⇒ 整卡包链接的推荐位卡片会被排除（BBC 相关阅读卡片、GitHub
    侧栏标题的泄漏源）。这条和"单链接标题豁免"（见 2.3 `isMostlyLinks`）不冲突：
    豁免管的是 `a` 在标题**内部**的情况，这条管的是标题在 `a` **内部**的情况。
- **TABLE / FORM 不做一刀切**，改用细粒度判定（结果用 `WeakMap` 缓存，避免重复计算）：
  - table 仅当是**数据表**才排除：有 `caption/thead/th`、或任一行 `td` 数 `>= 4`、
    或 `role="grid"/"table"`。命中即认为是数据表，整体排除——代码标识符和表头混排，
    整段翻译容易把 `<code>go build</code>` 之类连带译成"去建造"。不命中就是布局表
    （Hacker News 的嵌套 table 排版、老式网页排版），放行内部候选。
  - form 仅当是**真表单**才排除：含非 `hidden` 的 `input/select/textarea/button`
    才算真表单。old.reddit.com 把每条评论包在 `<form class="usertext">` 里（服务端
    渲染出的 HTML 只有一个 hidden input），一刀切排除会把全站评论都吞掉。
- **`paragraphText(el)`**：取候选文本一律用它而不是裸 `textContent`——跳过两类后代：
  - `style/script/noscript/template`：DOM 规范里它们的 `textContent` 是真实文本
    （浏览器只是不渲染），Wikipedia 的引用 `<li>` 内嵌 TemplateStyles `<style>`
    子元素时，裸 `textContent` 会把整段 CSS 当成引文文本一起翻译；
  - `button/select/textarea`：控件标注不是正文。`EXCLUDE_TAGS` 的 BUTTON 只管
    "候选在控件**里面**"（`closest` 查祖先），管不了"候选**包含**控件"——Agora 文档
    的代码 tab 栏 `<div role=tablist><button>Python SDK</button>…</div>` 全部文字都
    来自 button，又因 button 不在 `BLOCK_SELECTOR` 里照样通过叶子块门槛。跳过控件
    文字后这类 div 有效文本为空，被 `hasMeaningfulText` 挡掉；正文段落里混着的
    "Copy link" 之类按钮标注也不再随原文一起送翻。

  `page-translator.ts` 取待翻原文时也用这个函数，保证"评测看到的文本"和"实际发去
  翻译的文本"一致。

### 2.1 第一步：`findContentRoot()`

目标："最深的、保留 ≥80% 正文字符、且丢弃 ≤500 字符的子树"。

1. seed 依次兜底取 `document.querySelector('main')` → `'article'` → `document.body`。
2. seed 内非排除的 `<p>` 作为统计样本；**样本数 < 3 直接返回 seed**——样本太少做不了
   统计，强行统计反而不稳定。
3. 每个样本记 `paragraphText(p).trim().length` 为权重，累加得 `totalChars`。自底向上
   遍历 seed 子树，找"子树内样本字符和 `>= totalChars * ROOT_KEEP_RATIO`（0.8）**且**
   丢弃字符 `<= ROOT_MAX_DROPPED_CHARS`（500）"这个条件下**最深**的元素，作为最终
   root。

**为什么按字符量而不是按个数**：GitHub 的 `<main>` 里，README 的 `<p>` 只占**个数**
的 58%（不到 80%）——按个数算的版本收不窄，侧栏的零散 `<p>`（"About" 描述、加载失败
占位文字）全部混入。反过来 Stack Overflow 是另一个极端：answers 区的 `<p>` **个数**
占比超过 80%，按个数算的版本会把 root 收窄到 `#answers`，把整个问题区裁掉。字符量对
"多个短侧栏 `<p>` vs 少数长正文 `<p>`"更敏感——GitHub 侧栏那些零星短 `<p>` 加起来才
两三百字符，允许收窄进 README 的 `<article>`；Stack Overflow 问题区虽然 `<p>` 个数是
少数，但字符量有 1500+，不该被当噪声丢弃，root 因此停在包含问题和答案的共同祖先。

**为什么还要加 500 字符的绝对下限**：只用比例阈值，Stack Overflow 的
`#answers` 字符占比也可能超过 80%，比例条件仍会让 root 收窄进去、把问题区裁掉。
"丢弃的字符绝对值超过 500 就不许收窄"兜住了这种情况（问题区本身有 1500+ 字符，
超过 500 的绝对上限，收窄条件不成立，root 停在更高层级）。500 这个数字取自
Readability.js 的 `charThreshold` 默认值；实测中 GitHub 收窄后实际丢弃 250 字符
（侧栏短 `<p>`），Stack Overflow 停在 `#mainbar` 时丢弃 190 字符，都远低于 500，
说明这个阈值留有余量、不需要再调。

**已知代价**：如果正文外围存在 >500 字符的"合法但次要"内容（比如很长的页脚），
root 会偏宽，这部分交给第二步的过滤规则兜底，不在这一步解决。

### 2.2 常量取值一览

| 常量 | 值 | 含义 |
|---|---|---|
| `MIN_TEXT_LENGTH` | 4 | 候选文本 trim 后短于此长度直接判定为无意义（页码/序号） |
| `ROOT_KEEP_RATIO` | 0.8 | root 收敛：子树需保留的字符比例下限 |
| `ROOT_MAX_DROPPED_CHARS` | 500 | root 收敛：允许丢弃的字符绝对值上限（取自 Readability `charThreshold`） |
| `LEAF_MIN_CHARS` | 25 | div/td 叶子块候选文本长度下限，过滤 UI 碎屑 |
| `LEAF_MAX_CHARS` | 2000 | div/td 叶子块候选文本长度上限，过滤吞并多段的无结构 blob |

这五个常量在 2026-07 的算法改进里全部取初始给定值、未做调参——用真实页面实测时
GitHub/StackOverflow 的 root 收敛丢弃字符量分别是 250、190，离 500 的阈值有明显余量；
`LEAF_MIN/MAX_CHARS` 在当前 20 页样本集里也没有出现"差一点点就该收/不该收"的边界
抖动案例。如果以后新增页面样本触发了边界问题，应该先看是不是规则本身设计错了，
而不是简单调常量掩盖。

### 2.3 第二步：`collectParagraphs(root)`

在 root 内做两遍扫描。

**第一遍**：`root.querySelectorAll(LEAF_CANDIDATE_SELECTOR)`（段落标签 + `div,td`）
拿到全部候选节点，逐个判定是否"合格"（`qualifies`），全部条件都过才合格：

1. **`isExcluded`**：自身或祖先命中 `EXCLUDE_TAGS`/`a`（`.closest()`），或所在
   `table` 是数据表，或所在 `form` 是真表单 → 排除。
2. **`hasUnlikelyAncestor`**：从候选自身向上走到 root（不含 root），任一祖先的
   `class`/`id` 命中 `UNLIKELY_CLASS_RE` → 排除。这个正则借鉴 Readability
   `getClassWeight` 的负权重词表，词边界匹配（`(^|[-_ ])词([-_ ]|$)`）防止
   "abandoned" 之类的词命中 "ads" 子串。词表：
   `sidebar/footer/breadcrumbs?/banner/advert(isement)?/ads?/sponsor/promo/share/
   social/cookie/consent/gdpr/subscribe/newsletter/related/recommend(ed|ations?)?/
   popup/modal/toolbar/pagination/pager/masthead/disqus`。**刻意不含
   `comment/header/menu/nav`**——原因见第 1 节。
3. **`hasMeaningfulText`**：`paragraphText` trim 后长度 `< MIN_TEXT_LENGTH`（4）
   或不含任何 `\p{L}`（Unicode 字母）→ 排除。过滤页码、序号、纯标点。
4. **`isMostlyLinks`**：去空白后 `>= 70%` 的文字来自 `<a>` 后代 → 排除。这是判断
   "这行是不是 metadata"的启发式——正常正文段落里 inline link 不会占到 70%，
   但"用户名 + 时间戳"这类行几乎全是链接文字。**豁免**：标题标签（`h1-h6`）且
   恰好只有 1 个 `<a>` 子孙 → 不排除，因为文档站常把整个标题包进自链接锚点
   （MDN 的 `<h2><a href="#foo">标题</a></h2>`），这种是正文标题不是 metadata；
   但"用户名 `<a>` + 时间戳 `<a>`"这种多链接标题仍会被排除。
5. **div/td 叶子块候选的额外门槛**（`isLeafBlockTag` 分支，比段落标签更严）：
   - 不含 `hidden` 属性——这是"确实不渲染"的标记（Vite 文档页给爬虫/LLM 看的
     隐藏提示文本、GitHub 菜单里预先隐藏待 JS 切换的项），只查真正的 `hidden`
     布尔属性，不查 `aria-hidden`（大量出现在装饰性图标上，和内容是否隐藏无关）
     也不查 class 里的 "hidden" 字面量（Tailwind 的 `class="hidden lg:flex"`
     是响应式断点类名，不代表真隐藏）；
   - 不含任何 `BLOCK_SELECTOR` 命中的块级后代——保证这确实是"叶子"，不是包着
     其他候选的容器；
   - `paragraphText` 长度落在 `[LEAF_MIN_CHARS, LEAF_MAX_CHARS]` = `[25, 2000]`
     区间——太短是 UI 碎屑（按钮态文字等），太长很可能吞并了多个逻辑段落或是
     无结构 blob。

**第二遍**：只保留"最内层"的合格候选。先求出全体真正合格的候选集合
`eligible`，再对每个候选检查它是否包含**另一个也在 `eligible` 里**的候选作为
后代，如果是，则让位（比如 `<li>` 里包着合格的 `<p>` 时，只翻 `<p>` 不翻
`<li>`；`div`/`td` 叶子块候选同理）。

这里的关键是必须用"是否真的合格"而不是"是否匹配候选选择器"来判断要不要让位——
早期实现按选择器判断时，Substack 的自链接标题
`<h3>标题文字<div class="...">（纯图标按钮，空文本）</div></h3>` 会因为含有一个
`<div>`（哪怕这个 `div` 自己因为空文本永远不可能合格）就被跳过，标题和装饰性
`div` 一起从输出里消失。改成基于合格集合判断后，只有"确实还有一个合格候选嵌在
里面"才会让位。实现上是一次向上标记：每个合格候选沿着父链走到 root，途中经过的
合格祖先都被标记为"含有更内层合格后代"，复杂度 `O(n · depth)`，避免了逐对
`el.contains(other)` 的双重扫描。

## 3. 与 Readability.js 的关系

不引入 Readability.js 本身（70KB+ 对 content script 太重，而且它做的事和这里的
需求不完全对齐），但设计上借鉴了三个原理：

| Readability 原理 | 对应实现 |
|---|---|
| `getClassWeight()` 用 class/id 关键词给节点加减分 | `UNLIKELY_CLASS_RE` + `hasUnlikelyAncestor`（第 2.3 节第一遍第 2 条），只取负权重词表，不做加权打分 |
| 按文本量（字符数/`charThreshold`）而非节点数衡量内容占比 | `findContentRoot` 的字符量加权收敛（第 2.1 节），`ROOT_MAX_DROPPED_CHARS = 500` 直接借用 Readability 的 `charThreshold` 默认值 |
| 区分"数据表格"与"排版用的布局表格" | `isDataTable`（第 2 节 TABLE 细粒度判定），判定依据类似（是否有表头结构） |

**明确不借鉴的部分**，以及为什么：

- **打分传播**（Readability 给每个候选节点算 `contentScore`，逐级向上传播到祖先，
  最后选分数最高的节点）。这里不需要"选出单一最佳容器"——沉浸式翻译要的是"哪些
  元素的文本需要翻译"，`findContentRoot` 用一次性的字符量收敛就够定位大致范围，
  真正的取舍精度交给 `collectParagraphs` 的规则过滤，不需要一个连续打分系统。
- **DOM 改写**（Readability 会把 `<br><br>` 分隔的文本重组成 `<p>`、把单子元素的
  `<div>` 折叠成 `<p>`、把不认识的标签强制转成 `<div>` 等）。这里只读不写——翻译
  只需要"读到哪些文本节点该翻"，改写 DOM 会带来额外的正确性风险（破坏页面原有的
  事件监听、样式），且要保留原始结构以便 in-place 替换译文（见
  `docs/decisions.md` 的"双防重入"一节），收益不抵复杂度。
- **sibling 合并**（Readability 在选出 top candidate 后，会检查其兄弟节点，
  按分数或链接密度决定是否并入同一篇文章）。这本质是"把被 DOM 结构打散的同一篇
  文章拼回一个容器"的修复手段，是"提取单一正文容器"这个目标特有的需求；这里的
  `collectParagraphs` 本来就是在全部 root 子树内平铺搜集候选，不需要"拼回一个
  容器"这一步。

## 4. 评测

回归测试集在 `eval/`，用法见 `eval/README.md`（跑 `bun run eval`，看
`git diff eval/results/` 判断改动是否引入回归；新页面的收录流程也在那份 README 里）。

当前 20 页样本的结论快照（2026-07，均以 `eval/results/*.txt` 为准）：

| 页面 | 结论 | 说明 |
|---|---|---|
| Wikipedia（Alan Turing） | good | 435→441 段，原有的 TemplateStyles CSS 泄漏 bug 已修复 |
| MDN（IntersectionObserver） | good | 自链接标题豁免、mostly-links 过滤均按预期工作 |
| GitHub（vscode 仓库主页） | good | root 正确收窄到 README 的 `<article>`，侧栏噪声消失 |
| Hacker News（评论页） | good | 嵌套 table 布局放行后评论全部收录，导航行被 mostly-links 挡住 |
| Hacker News（首页列表） | partial | 列表页非强制核查范围，subtext 元数据行会混入 |
| Stack Overflow（sorted array 问题） | partial | 问题正文和答案均已收录；"Copy link"/"N Comments"/排序 tab 等按钮噪声已被控件文字跳过规则清掉，仍有少量徽章类噪声（声誉徽章行）与底部 CTA 组件泄漏 |
| BBC（新闻文章） | good | 推荐卡标题被 `a` 祖先排除规则挡住，正文完整 |
| BBC（新闻列表） | partial | 列表页非强制核查范围 |
| Guardian（文章） | good | 与人工核对结果字节级一致 |
| Guardian（列表） | partial | 列表页非强制核查范围，摘要 div 会混入 |
| danluu.com | good | 页面本身结构简单，无侧栏噪声 |
| paulgraham.com（How to Do Great Work） | fail（已知不支持） | 见下方"已知不支持" |
| Vite 官方指南 | good | 左侧导航、页内 TOC 均未泄漏 |
| 阮一峰博客（周刊 #402） | good | 无 `<main>` 标签也能正确收窄，侧栏无泄漏 |
| 阮一峰博客（列表页） | partial | 列表页非强制核查范围 |
| Astral Codex Ten / Substack（文章） | good | 自链接标题的装饰性空 div 让位问题已修复 |
| Astral Codex Ten（列表页） | partial | 首页几乎无正文段落，非强制核查范围，2 段属预期 |
| old.reddit.com（评论页） | good | 98% 的 `.md p` 评论段落被正确收录，真表单判定放行评论 |
| synthetic（手写覆盖用例） | good | 覆盖侧栏稀释、自链接标题、mostly-links、表格排除、li/p 去重等场景 |
| Agora Docs（managed mode，headless Chrome 抓取的 JS 渲染站） | good | 代码示例 tab 栏（`<div role=tablist>` 包 button 组）被控件文字跳过规则挡住；页面自带的正文重复渲染（同段落出现两次）如实反映在输出里，属页面结构而非算法问题 |

**已知不支持**：

- **paulgraham.com 式远古排版**：整页零 `<p>`/`<li>`/标题标签，正文全靠
  `<font>` + `<br><br>` 分隔、整篇塞在一个布局表的 `<td>` 里。布局表本身已放行
  （非数据表），但 `PARAGRAPH_SELECTOR` 匹配不到任何段落节点，而那个 `<td>` 作为
  叶子块候选又因整篇文章远超 `LEAF_MAX_CHARS`（2000 字符）被拒——就算收进来也是
  一整篇不分段的 blob，翻译体验同样不可用。真正的修复需要在 DOM 里按 `<br><br>`
  重组出 `<p>` 边界（Readability 的 `_prepDocument` 做法），属于本算法故意不做的
  "DOM 改写"范畴（见第 3 节），不值得为这一种远古排版引入。
- **www.reddit.com（新版）**：`curl` 抓取拿到的是反爬虫空壳页（JS 渲染前的
  骨架，无实际评论内容），未能构造出有效测试样本，因此未实测。真实浏览器环境
  下 content script 面对的是渲染完成后的 DOM，不受这个限制影响；等有用户反馈
  再针对性验证。

## 5. 维护约定

- 改 `src/page-content.ts` 之后必须跑 `bun run eval`，人工核对
  `git diff eval/results/`：干净说明无回归；有 diff 要逐条确认是预期的改进还是
  意外的回归，确认后把新的 `results/*.txt` 一起提交。
- 用户反馈某个页面正文识别有问题时，按 `eval/README.md` 里"如何收录新页面"一节
  的标准流程处理：抓页面存进 `eval/pages/`、跑评测、人工核对问题现象、修算法、
  确认新页面改善且老页面无回归，最后连同新样本和新基线一起提交。
