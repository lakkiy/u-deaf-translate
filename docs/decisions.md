# 设计决策与技术选型

记录"为什么这么做"——避免以后回头时重新讨论同一个问题。每条决策一段，含上下文和理由。

## 架构

### 翻译逻辑全在 content script；service worker 做菜单注册 + LLM fetch 代理
Chrome Translator API 不能在 Worker 上下文调用，而 MV3 service worker 本质就是 worker——Chrome 内置翻译必须放 content script。早期不用 service worker（省消息传递开销），后来加"右键菜单整页翻译"被迫引入（`chrome.contextMenus` 只能在 background 注册），再后来加"自定义 LLM 后端"又借 service worker 代发 fetch（content script fetch 受页面 CORS 限制，绕不过用户配置的任意 endpoint）。`src/background.ts` 现在只做这两件事：菜单注册 + `tnyl:llm-fetch` 消息代理 fetch。

### 右键菜单触发整页翻译，用消息转发到 content
`contextMenus.onClicked` → `chrome.tabs.sendMessage(tabId, { type: 'tnyl:translate-page' })` → content script 的 `chrome.runtime.onMessage` → `startPageTranslation()`。在 `chrome://`、商店页等没注入 content 的页面右键，sendMessage 会 reject——background 端 `catch` 后 `console.warn` 静默，跟划词翻译的限制一致。

### Popup「翻这一页」直接从扩展页发 `tnyl:translate-page` 到当前 tab，不经 background
点图标弹出的 `src/popup.html`/`popup.ts` 运行在扩展页上下文（不是 content script），`chrome.tabs.query({active,currentWindow})` 拿到当前 tab 再 `chrome.tabs.sendMessage(tab.id, {type:'tnyl:translate-page'})`——和右键菜单走同一条消息、同一个 content 端 handler，行为完全一致（再点即取消）。复用现有 message type 而不新增，content.ts 那个 listener 不用动。无需新权限：`tabs.query/sendMessage` 在扩展页本就可用，`host_permissions` 覆盖 sendMessage。注入不到 content 的页面（chrome:// 等）sendMessage reject，`catch` 静默。popup 故意极简——按用户要求砍掉 stats（今日tokens/延迟/成本）、快捷键提示、提示词预设；只留「正在用 + 换后端（循环切 config.active）」「翻成（改全局 config.targetLanguage）」「翻这一页」「齿轮开 options」。

### 整页翻译的正文选取算法（`findRoot` + `collectParagraphs`，不引入 Readability.js）
**这套算法是沉浸式翻译的核心，下面写全到能脱离代码复现。** 不引入 Readability.js（70KB+ 太重），手写两步启发式：先 `findRoot()` 圈出正文容器，再 `collectParagraphs()` 在容器内挑要翻的段落。两个标签集是算法的基础：

- **PARAGRAPH_TAGS（候选段落标签）**：`p / li / h1 / h2 / h3 / h4 / h5 / h6 / blockquote / dd`。
- **EXCLUDE_TAGS（自身或任一祖先命中即整体排除）**：
  - `PRE / CODE / SCRIPT / STYLE / NOSCRIPT` —— 代码与脚本不翻，且 `textContent` 会把 `<code>` 子节点的代码字符一并吞进去翻乱；
  - `NAV / HEADER / FOOTER / ASIDE / MENU` —— 导航 / 页眉页脚 / 侧栏，非正文；
  - `BUTTON / SELECT / FORM / TEXTAREA / INPUT` —— 交互控件；
  - `TABLE` —— 整表跳过（理由见下一条独立决策）。

**第一步 `findRoot()` —— "最深的、覆盖 ≥80% `<p>` 的子树" 即正文容器：**
1. seed 取 `<main>` → `<article>` → `<body>`（依次兜底）。
2. 统计 seed 内所有 `<p>`（排除落在 EXCLUDE_TAGS 内的）得 `validPs`。**若 `validPs.length < 3` 直接返回 seed**——样本太少做不了统计，整个 seed 当正文。
3. 否则 `target = ceil(validPs.length * 0.8)`，遍历 seed 整棵子树，对每个元素算它子树内含多少个 `validPs`，记下"含量 ≥ target 的**最深**元素"作为正文容器返回。
- 为什么拿 `<p>` 数量当信号、且要"最深"：正文容器（README、文章主体）的 `<p>` 占绝对多数，侧栏 / 元数据区即使有零星 `<p>` 也凑不到 80%；"最深"保证收敛到最窄的合适容器。代价：当真正的正文被拆进两个并列容器（各自 < 80%）时会回退到 seed——目前没遇到。演化史见 pitfalls："正文识别"几条记录了从「所有 `<p>` 的 LCA」（被侧栏一个 `<p>` 拉宽到整个 `<main>`）改到「80% 覆盖最深子树」的过程。

**第二步 `collectParagraphs(root)` —— 容器内逐个筛候选，全部通过才翻：**
- 已带 `data-tnyl-translated` 标记 → 跳过（防重入）；
- 自身或任一祖先在 EXCLUDE_TAGS 内 → 跳过；
- `hasMeaningfulText` 不过 → 跳过：`trim()` 后**少于 4 字符**（`MIN_TEXT_LENGTH`），或**不含任何字母**（`/\p{L}/u` 不匹配）。滤掉页码、序号、纯标点；
- `isMostlyLinks` 命中 → 跳过：去空白后的文本**≥ 70% 来自 `<a>` 子节点**。滤掉"用户名 + 时间戳"这类几乎全是链接的元数据行（正常正文的 inline link 占比远不到 70%）；
- 内部还含其它候选（`el.querySelector(PARAGRAPH_TAGS)` 非空）→ 跳过，**只翻最内层**，避免 `<li><p>…</p></li>` 把 `<li>` 和 `<p>` 双翻。

### `<table>` 整张跳过，不把 `<td>` 当段落
表格里常混代码标识符（`go build` / `cargo build`）和短英文说明（"Compile the project"），但 `textContent` 会把 `<code>` 子节点的代码字符也一并取出来送去翻译，得到"去建造"、"货物建造"这种荒谬结果。逐 cell 判断"是不是主要内容是 code"启发式很脆，按用户反馈整张表跳过最稳。代价是表格里的英文说明不翻——可接受。

### 整页译文节点 inject 全局 `<style>` 而非 Shadow DOM
划词翻译用 closed Shadow DOM 隔离样式，整页翻译做不到——译文要跟原文同字号/行高/排版，必须沿用原页面的 CSS 继承链。代价是样式可能被页面覆盖。class 名加 `tnyl-` 前缀（`tnyl-translation`）降低冲突概率，关键属性用 `inherit` 让原文样式自然带过来。

### 整页翻译用 `data-tnyl-translated` + pending 节点双防重入
段落进入视口后立刻给原文加 `data-tnyl-translated` + 在 afterend 插入带 `data-tnyl-pending` 的占位 div——双层防御 IntersectionObserver 在同一段上重复触发。pending 显示"翻译中…"（opacity 0.5 + 斜体），翻译完成只替换 `textContent`，不动 DOM 结构，避免布局抖动。

### Closed Shadow DOM 隔离气泡 UI
气泡用 `attachShadow({ mode: 'closed' })` 包起来。网页 CSS 不污染气泡，气泡的样式也不会泄漏到网页；`mode: 'closed'` 还防止网页通过 JS 访问内部节点。

### 定位以鼠标指针为锚点，按实际尺寸算
触发器和气泡都以 mouseup 的 clientX/Y 为锚点，右下方 12px 偏移。右边放不下时翻到左侧（右边缘对齐 anchor）。用**实际渲染宽度**算翻转条件——触发器（32px）紧贴鼠标，展开时沿同一侧延展，视觉上是"原地长出气泡"，不会突然跳到屏幕另一侧。

### 触发器先现，点击才翻译
不直接翻译——选中文本先弹一个小图标，用户主动点了才调 API。避免误选触发翻译耗资源，也给用户拒绝/确认的机会。

## 性能 / UX

### 触发器显示 150ms 防抖
mouseup 后等 150ms 才显示触发器。快速选/取消、双击选词等场景下，期间任何新 mouseup/mousedown/scroll 都会清掉定时器重排。避免闪烁。

### Spinner 显示 200ms 延迟
点击触发器后等 200ms 再换成 spinner。短翻译（缓存命中、几百字以内）通常 <200ms 完成，根本看不到 spinner——避免无意义的闪烁。长翻译才会显示 spinner。

### 不显示 loading/downloading 文字
用户明确反馈不要"正在翻译"这类文字状态。只用图标→spinner→结果三个视觉态。下载进度只 `console.log`。

### 同一语言对的 Translator 缓存为 Promise
存的是 `Promise<TranslatorInstance>`，不是已解析的实例——并发请求会自然共享同一次下载，无需额外同步。失败的 promise 从缓存里移除，允许下次重试。

### 按换行符切分逐段翻译
整段含换行的文本直接传给 Translator 会被压平成一行。`split(/(\n+)/)` 用 capturing group 切分（分隔符也保留在结果数组里），每段独立调 translate，再原样拼回，保留段落结构。

### 整页翻译懒加载：IntersectionObserver `rootMargin: '300px 0px'`
段落距视口边缘 300px 以内才开始翻译。300px 是折中——再大首屏并发太高，再小用户滚到时还没翻完。

### 整页翻译并发限制 3
首屏可能有 10+ 段同时进入观察范围。简易队列（`inflight + queue`）允许同时 3 个翻译 in-flight，其余排队。`getTranslator` 单实例缓存让这 3 个并发段落共享同一个 Translator，不会撞 service count 多实例上限。

### 整页翻译只检测一次源语言
`detectedLanguagePromise` 单例 promise，所有段落复用第一段的检测结果。每段都检测既浪费又不可靠（短段落置信度低）；用全页第一段足以代表整页。

## 样式

### 跟随系统主题
`:host` 上用 CSS 变量定义颜色，`@media (prefers-color-scheme: dark)` 覆盖一组暗色值。无需 JS 干预，跟随系统切换实时生效。

### 气泡可滚动放到内层 `.scroll`，卡片本体 `overflow: visible` 留给尾巴
长译文限高 `56vh` + `overflow-y: auto` + `overscroll-behavior: contain`（防止滚到底/顶后滚动事件传到页面把气泡关掉）。这层从卡片 `.info` 下移到内层 `.scroll` 是因为给气泡加了指向选区的小尾巴（`.info::before` 旋转方块、探出卡片边缘）——若滚动留在卡片上，`overflow:auto` 会把探出的尾巴裁掉。卡片本体改 `overflow: visible`。

### 气泡尾巴指向选区，方向随翻转切换
气泡按设计稿 ② 做成「朴素」白/暗底卡片（不是 popup/options 的米色纸感）+ 一个指向选区的小尾巴：`::before` 用旋转 45° 的方块，只给朝外的两条边描边（`border-left+border-top` 朝上 / `border-right+border-bottom` 朝下），下半与卡片同底色无缝融入。`positionHost` 已知气泡相对 anchor 的水平/垂直翻转（`flipX`/`flipY`），据此加 `tail-top|bottom` + `tail-left|right` 让尾巴始终贴在靠近选区的那条边。

### 触发器无外框，hover 用 transform: scale 而非 background
图标本身是带边框/阴影的完整贴纸设计，再加白色外框反而冗余。hover 用 `transform: scale(1.12)` 比 `background` 变色更不易踩"半透明替换"的坑。

## 工具链

### Bun（包管理）+ Vite + @crxjs/vite-plugin
Bun 单独做 Chrome 扩展太粗糙——没有 HMR、没有 manifest 自动处理，要写胶水脚本。Vite + CRXJS 是社区主流，CRXJS 自动解析 manifest 引用、HMR 工作良好。Bun 留着做包管理（快）。

### TypeScript 严格模式 + `vite/client` 类型
`strict: true` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`。`vite/client` 类型让 `?inline` 之类的资源 query 能被 TS 识别。

### 不用 UI 框架
气泡 UI 简单（3 个状态、几个 DOM 元素），原生 DOM API + 手写 CSS 最易读。引入 Preact/React 反而是负担。

### 触发器图标用 `?inline` 内联为 base64
PNG 直接 `import './trigger-icon.png?inline'` 内联进 JS。代价是 content script 多 ~8KB；好处是不用动 `web_accessible_resources`（否则要把图标资源对所有页面公开），并且任意网站都能加载。

## 范围

### 三后端：Chrome / DeepSeek / 自定义，options 页卡片式互斥选择
`config.active: 'chrome' | 'deepseek' | 'custom'` 决定 `translate()` 走哪条路径。DeepSeek 的 endpoint 仍在 `src/deepseek.ts` 写死（`DEEPSEEK_MODELS` 数组列可选 model，改模型只改这个数组），但 **system / prompt / 生成参数已从写死常量改成可在 options 编辑的 config 字段**（`deepseekSystem` / `deepseekPromptTemplate` / `deepseekExtraParams`），默认值取 config.ts 的 `DEEPSEEK_DEFAULT_*` 常量——既给新手一个能直接用的默认，又允许进阶用户调教（含系统提示词）。自定义后端在原有 5 字段基础上加了 `system`。三个后端的配置在 storage 各自独占字段，切后端不丢任何输入；所有字段都在 DOM 里渲染，切后端只调 `.selected`/`.active` class，state 天然 persist。options 用卡片网格替代旧 tab 栏（纯视觉），并在最上方增设「壹 翻译」语言区块。

### LLM 后端的 fetch 必须经 background 代理
content script 直接 fetch 用户配置的 endpoint 受页面 CORS 影响（除非 endpoint 自己返了正确的 `Access-Control-Allow-Origin`，多数本地部署没设）。Service worker fetch 不受 CORS 限制，但需要 `host_permissions`——目前用 `["http://*/*", "https://*/*"]` 覆盖任意 endpoint。消息协议：content → `chrome.runtime.sendMessage({ type: 'tnyl:llm-fetch', url, headers, body })` → background fetch → `sendResponse({ ok, status, data | error })`，MV3 异步响应必须 `return true` 保持 channel。

### DeepSeek tab 图标用 inline SVG，不用外链/字体图标
避免外链：CSP 风险（manifest V3 img-src 默认收紧）+ 第三方品牌图片版权问题。`src/deepseek.ts` 的 `DEEPSEEK_ICON_SVG` 是手写 SVG 字符串（32x32 viewBox），tab 渲染时 `innerHTML` 注入——来源是项目源码不是用户输入，XSS 不构成风险。用品牌主色 `#4D6BFE` 圆底 + 白色波浪线（致意 "deep sea"），不像官方 logo 但传达意象。

### 旧 schema 一次性迁移到 `custom` tab
0.x 阶段配置 schema 从扁平字段（`endpoint`/`apiKey`/`model`/...）变成 `{ active, deepseekApiKey, custom: {...} }`。`getConfig()` 第一次读到旧扁平字段（有 `endpoint` 但没有 `active`/`custom`）就 move 进 `custom` 子对象，`active` 设为 `'custom'`（用户之前配过 endpoint 肯定是想用自定义），写回后 remove 旧字段。代价 30 行代码，但旧用户的 prompt 模板、参数都不丢。

### Prompt 模板用 `{target_lang}` / `{source_text}` 占位符（单括号，故意不改双括号）
`config.promptTemplate` 默认 Hy-MT2 推荐格式：`将以下文本翻译为 {target_lang}，注意只需要输出翻译后的结果，不要额外解释：\n\n{source_text}`。渲染用 `replaceAll`，不做转义——LLM 自身能处理特殊字符，用户填的模板我们尊重。Options 页面保存时如果模板缺占位符给软警告（仍允许保存）。一份 UI 设计稿把占位符画成 `{{text}}`/`{{target_lang}}`/`{{source_lang}}`（双括号 + 重命名 + 新增），**有意不采纳**：那只是设计稿的「样子」，改渲染会让所有用户已存的单括号模板失效（占位符不再被替换，译文里冒出裸 `{source_text}`），收益不抵破坏。`src/prompts.ts` 的预设文案也沿用单括号。

### System / User 双段 prompt：system 可选，空则退回单条 user
`renderPrompt` 之外，`translateViaLlm` 在 `config.system` 非空时多发一条 `{role:'system'}`（同样走 renderPrompt，里面也能用占位符）；空 system 时只发一条 user。自定义后端默认 `custom.system` = `DEFAULT_SYSTEM_PROMPT`（约束保留专有名词、产品名、人名、代码标识符原文，别强行翻译），新装即带；DeepSeek 默认 `deepseekSystem=''` 维持只发 user。新增的 config 字段（语言、deepseek 三件套、custom.system）走 `getConfig` 的默认值合并：曾存过 5 字段 custom（无 `system` key）的老用户会被补上这条默认 system——属良性增强，其余已存配置不动。

### 自定义后端默认 `max_tokens` 用 4096
`config.ts` 的 `DEFAULT_EXTRA_PARAMS` 早期照搬 Hy-MT2 模型卡示例的 `max_tokens: 128`（约 90 汉字），太小：同一份 config 也供整页翻译，长段落会被截断。先提到 1024，仍偏紧，最终定 4096——整页长段落留足额度。DeepSeek 分支（`DEEPSEEK_DEFAULT_EXTRA_PARAMS`）有自己的调优（`max_tokens 1024` + `thinking` 关），不跟随这个值。

### 自定义端点默认指向本地 llama.cpp，UI 去掉 Ollama 字样
`DEFAULT_CUSTOM.endpoint` 默认 `http://127.0.0.1:8080/v1/chat/completions`（llama.cpp server 默认地址），新装即填好，本地起了服务就能直接用。options 文案与占位符里原先的 "Ollama" 提示、`11434` 端口、`qwen2.5:7b` 这类 ollama tag 写法全部移除（按用户要求弃用 Ollama），示例统一改成 llama.cpp 的 `8080` 与 `Qwen3-8B` 这类裸模型名。

### 语言中文名手写表 + Intl 兜底
`src/languages.ts` 手写 37 种 Hy-MT2 支持语言的 BCP-47 → 中文名映射（从模型卡复制）。手写比 `Intl.DisplayNames` 可控——`Intl` 把 `zh` 译为"汉语"而表里固定"中文"；某些少数语言 `Intl` 译名也有差异。`getLanguageDisplayName()` 先查表，没命中退到主子标签（`zh-CN` → `zh`），最后兜底 `Intl.DisplayNames`。

### 配置存 `chrome.storage.sync` + module-level 缓存 + onChanged 失效
跨设备同步；条目都很小（prompt 模板 ≪ 8KB 限额）。content / background / options 三个上下文共享，options 页面改完 background/content 通过 `chrome.storage.onChanged` 收到事件后清模块缓存——下次 `getConfig()` 重新读。不用每次翻译都打 storage（虽然很快，但能少就少）。

### 互译：选中文本与目标语言同族 → 翻向「另一边」，否则 → 翻向目标
目标语言现在是用户可配的 `config.targetLanguage`（默认 `zh-Hans`），不再写死。`pickTargetLanguage(source, primaryTarget)` 用 `sameLanguageFamily()` 比较 BCP-47 主子标签（`zh-Hans` / `zh-CN` / `zh-TW` 同族）：同族就翻向 `reverseTarget(primaryTarget)`（目标是英语族则回译中文，否则回译英文），否则翻向目标。这样选英文/法文/任意外语都翻成中文、选中文翻成英文的便利保留下来，目标可改。源语言同理由 `config.sourceLanguage` 配置（默认 `'auto'`）：`resolveSourceLanguage()` 在非 auto 时直接用用户指定值跳过检测，划词/整页两条路径共用。**注意：绝不能让 `source === target`**——会让 resolveSourceLanguage 锁死源、pickTargetLanguage 判同族强行反向，方向错乱（见 pitfalls 的 swap 坑）。

### 检测置信度低 / `und` 时按英语兜底
LanguageDetector 对短文本置信度低或返回 `und`。直接按英语兜底，气泡里加"（源语言不确定，按英语翻译）"小提示。比直接报错有用。

### LanguageDetector 不可用时用启发式兜底（让 LLM 后端脱离 Chrome 内置 AI）
`detectLanguage()` 的唯一用途是 `pickTargetLanguage()` 二选一（译中 / 译英）。旧实现直接引用全局 `LanguageDetector`，浏览器没有 Chrome 内置 AI 时会抛 `ReferenceError`——DeepSeek/custom 这条本该独立于 Chrome 的后端路径反而走不通。改成 `typeof LanguageDetector === 'undefined'` 时走 `detectByHeuristic()`：含汉字按 `zh`、否则按 `en`，`uncertain: true`。粗略但够二选一；精确检测本来就依赖那个缺席的 API。Chrome 后端在 138+ 上行为不变（API 存在仍走 `LanguageDetector`）。

### 无总长度限制，只有 60s 单次创建超时
没有总文本长度上限。多段翻译靠换行切分逐段处理。`Translator.create()` 加 60s 超时（某些不支持的语言对会让 create 永远 hang）。

### iframe 内不工作（`all_frames: false`）
早期试过 `all_frames: true` 但跨域 iframe 调 Translator API 需要父页面给 iframe 加 `allow="translator"` 权限策略（浏览器策略，扩展绕不过）。AWS 等多 iframe 站点都没加——`true` 只是让触发器在 iframe 里出现但点了报错，反而误导用户。索性关掉。

### `<input>` / `<textarea>` 选区粗略定位到输入框右下角
精确到光标需要 mirror-div 技巧，复杂度过高。post-MVP 再考虑。

### 整页翻译：再次右键 = 取消，靠 sessionId 拦截 in-flight 回调
菜单只有一项"翻译整页（沉浸式）"，行为是 toggle：未启动则翻译，已启动则停 observer、清队列、移除所有 `.tnyl-translation` 节点和 `data-tnyl-translated` 标记。in-flight 翻译没法 cancel（Translator.translate 不接 AbortSignal），用 `sessionId` 计数器：每次 start/stop 都 `++`，task 完成时 session 不匹配就 return，不写回 DOM。menu title 不动态切换（要让 background 知道 per-tab 状态太复杂），用户点两次自然就理解。

### 整页翻译暂不支持 SPA 路由重扫
SPA 切路由后新加载的段落不会被自动翻译，需要再次右键触发——`data-tnyl-translated` 标记会让已翻译的跳过，只翻新内容。等用户反馈再考虑加 MutationObserver。

## 错误处理

### 错误信息用中文 + Intl.DisplayNames 显示语言名
Chrome 原始错误是英文（"Unable to create translator..."）。捕获后用 `Intl.DisplayNames(['zh-Hans'], { type: 'language' })` 把 BCP 47 代码（`is`）转成中文（"冰岛语"），抛出"暂不支持「冰岛语」翻译为简体中文"。原始错误保留在 `console.error`。

### Session ID 取消失效请求
每次选区/触发器创建都 `++currentSessionId`。异步操作开始时记下自己的 session，回调里 session 不等于当前就 return。避免快速连续操作时旧结果覆盖新结果。

## 隐私 / 法律

### MIT License
最宽松，发扩展最常见。

### 不联网、不收集、不上报
扩展不调任何远端服务、不上报使用数据、不读敏感信息。翻译完全本地完成，模型下载由 Chrome 自身完成（不是扩展）。Chrome 商店审核硬性要求隐私声明，写在 README 里。
