# 设计决策与技术选型

记录"为什么这么做"——避免以后回头时重新讨论同一个问题。每条决策一段，含上下文和理由。

## 架构

### 代码结构：`src/` 按运行上下文分一层文件夹，文件夹内平铺
`content/`（注入网页的脚本：划词 `content.ts` + 气泡 `bubble.ts` + 整页 `page-translator.ts` + 正文识别 `page-content.ts`）、`translate/`（入口 `translate.ts` 分发到 `chrome.ts` / `llm.ts` 两个后端）、`options/`、`popup/`；`src/` 根只放 service worker `background.ts` 和两个全局共享的 `config.ts` / `languages.ts`。依赖只有一个方向：`content → translate → config/languages`，`options`、`popup → config/languages`，`background` 不 import 任何东西。约束：`config.ts` / `languages.ts` 必须保持无 DOM 副作用（options / popup 也要 import）；带顶层监听器的东西（`translate/chrome.ts` 的 pagehide/visibilitychange）只能被 content 侧引用。不追求分层架构，够读就行——新文件先想清楚属于哪个上下文再放。

### 翻译逻辑全在 content script；service worker 做菜单注册 + LLM fetch 代理
Chrome Translator API 不能在 Worker 上下文调用，而 MV3 service worker 本质就是 worker——Chrome 内置翻译必须放 content script。早期不用 service worker（省消息传递开销），后来加"右键菜单整页翻译"被迫引入（`chrome.contextMenus` 只能在 background 注册），再后来加"自定义 LLM 后端"又借 service worker 代发 fetch（content script fetch 受页面 CORS 限制，绕不过用户配置的任意 endpoint）。`src/background.ts` 现在只做这两件事：菜单注册 + `tnyl:llm-fetch` 消息代理 fetch。

### 右键菜单触发整页翻译，用消息转发到 content
`contextMenus.onClicked` → `chrome.tabs.sendMessage(tabId, { type: 'tnyl:translate-page' })` → content script 的 `chrome.runtime.onMessage` → `startPageTranslation()`。在 `chrome://`、商店页等没注入 content 的页面右键，sendMessage 会 reject——background 端 `catch` 后 `console.warn` 静默，跟划词翻译的限制一致。

### Popup「翻这一页」直接从扩展页发 `tnyl:translate-page` 到当前 tab，不经 background
点图标弹出的 `src/popup/popup.html`/`popup.ts` 运行在扩展页上下文（不是 content script），`chrome.tabs.query({active,currentWindow})` 拿到当前 tab 再 `chrome.tabs.sendMessage(tab.id, {type:'tnyl:translate-page'})`——和右键菜单走同一条消息、同一个 content 端 handler，行为完全一致（再点即取消）。复用现有 message type 而不新增，content.ts 那个 listener 不用动。无需新权限：`tabs.query/sendMessage` 在扩展页本就可用，`host_permissions` 覆盖 sendMessage。注入不到 content 的页面（chrome:// 等）sendMessage reject，`catch` 静默。popup 故意极简——按用户要求砍掉 stats（今日tokens/延迟/成本）、快捷键提示、提示词预设；只留「正在用 + 换后端（循环切 config.active）」「翻成（改全局 config.targetLanguage）」「翻这一页」「齿轮开 options」。

### 整页翻译的正文选取算法（`src/content/page-content.ts`：`findContentRoot` + `collectParagraphs`，不引入 Readability.js）
两步启发式：`findContentRoot` 找最深的、保留 ≥80% 正文字符且丢弃 ≤500 字符的子树作为正文容器，`collectParagraphs` 在容器内两遍扫描挑出候选段落（排除规则筛一遍，"让位给更内层合格候选"再筛一遍）。不引入 Readability.js（70KB+ 太重），但借鉴其三个原理：class/id 负面词过滤、按文本量而非节点数衡量内容、区分数据表与布局表。完整设计、各常量论证、与 Readability 的详细对照、评测结论见 `docs/content-detection.md`。

### `<table>` 从"整张跳过"改为"仅数据表跳过"
最初按用户反馈整表跳过：表格常混代码标识符（`go build` / `cargo build`），`textContent` 把 `<code>` 子节点的代码也送去翻译，得到"去建造"、"货物建造"。2026-07 实测发现一刀切让 HN 这类 table 布局页整页 0 段落——布局表是结构容器不是数据表。改为 `isDataTable` 判定（有 caption/thead/th、任一行 td ≥ 4、或 role=grid/table 才排除）：corrode.dev 那张带表头的对比表仍被排除，原始动机保住；HN 的嵌套布局表放行。同理 FORM 也从一刀切改为"真表单"判定（见算法主条目）。

### 整页译文节点 inject 全局 `<style>` 而非 Shadow DOM
划词翻译用 closed Shadow DOM 隔离样式，整页翻译做不到——译文要跟原文同字号/行高/排版，必须沿用原页面的 CSS 继承链。代价是样式可能被页面覆盖。class 名加 `tnyl-` 前缀（`tnyl-translation`）降低冲突概率，关键属性用 `inherit` 让原文样式自然带过来。

### 整页翻译用 `data-tnyl-translated` + pending 节点双防重入
段落进入视口后立刻给原文加 `data-tnyl-translated` + 在 afterend 插入带 `data-tnyl-pending` 的占位 div——双层防御 IntersectionObserver 在同一段上重复触发。带标记的段落在 page-translator.ts 里 `collectParagraphs(root).filter(...)` 时排除（标记是翻译状态，不进 page-content.ts 的算法模块），SPA 重扫时只翻新内容。pending 显示"翻译中…"（opacity 0.5 + 斜体），翻译完成只替换 `textContent`，不动 DOM 结构，避免布局抖动。

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
`config.active: 'chrome' | 'deepseek' | 'custom'` 决定 `translate()` 走哪条路径。DeepSeek 的 endpoint 在 `src/config.ts` 写死（`DEEPSEEK_ENDPOINT`；`DEEPSEEK_MODELS` 数组列可选 model，改模型只改这个数组，第一个是默认），但 **system / prompt / 生成参数已从写死常量改成可在 options 编辑的 config 字段**（`deepseekSystem` / `deepseekPromptTemplate` / `deepseekExtraParams`），默认值都在 config.ts 的 `DEFAULT_CONFIG` 一个对象里（也是「恢复默认」的来源）——既给新手一个能直接用的默认，又允许进阶用户调教（含系统提示词）。自定义后端在原有 5 字段基础上加了 `system`。三个后端的配置在 storage 各自独占字段，切后端不丢任何输入；所有字段都在 DOM 里渲染，切后端只调 `.selected`/`.active` class，state 天然 persist。options 用卡片网格替代旧 tab 栏（纯视觉），并在最上方增设「壹 翻译」语言区块。

### LLM 后端的 fetch 必须经 background 代理
content script 直接 fetch 用户配置的 endpoint 受页面 CORS 影响（除非 endpoint 自己返了正确的 `Access-Control-Allow-Origin`，多数本地部署没设）。Service worker fetch 不受 CORS 限制，但需要 `host_permissions`——目前用 `["http://*/*", "https://*/*"]` 覆盖任意 endpoint。消息协议：content → `chrome.runtime.sendMessage({ type: 'tnyl:llm-fetch', url, headers, body })` → background fetch → `sendResponse({ ok, status, data | error })`，MV3 异步响应必须 `return true` 保持 channel。

### DeepSeek 卡片图标是手写 inline SVG，不用外链/字体图标
避免外链：CSP 风险（manifest V3 img-src 默认收紧）+ 第三方品牌图片版权问题。SVG 直接写在 `src/options/options.html` 的卡片标题里（32x32 viewBox），不再经 JS 常量 + `innerHTML` 注入——图标只有 options 一处用，写在 HTML 里少一层。用品牌主色 `#4D6BFE` 圆底 + 白色波浪线（致意 "deep sea"），不像官方 logo 但传达意象。

### 扁平旧 schema 的迁移代码已删除
早期 `getConfig()` 里有一段把扁平字段（`endpoint`/`apiKey`/`model`/...）move 进 `custom` 的一次性迁移。2026-10 清理时核对 git 历史：`config.ts` 首次提交（a2a9275）就已经是嵌套 schema，扁平 schema 从未出现在任何 commit 或打包产物里，只在当时的开发机上存在过，早已迁完——所以整段删掉。`getConfig()` 现在只做 `{ ...DEFAULT_CONFIG, ...stored, custom: { ...DEFAULT_CONFIG.custom, ...stored.custom } }` 的默认值合并：以后新增字段靠它透明升级；真要改字段形状（改名/挪位置）时再写迁移。

### Prompt 模板用 `{target_lang}` / `{source_text}` 占位符（单括号，故意不改双括号）
DeepSeek 默认模板是 Hy-MT2 推荐格式：`将以下文本翻译为 {target_lang}，注意只需要输出翻译后的结果，不要额外解释：\n\n{source_text}`；自定义端点默认模板是 `请将以下文本翻译为{target_lang}，直接输出翻译结果，不要进行任何解释。\n\n{source_text}`（2026-10 用户给的截图里写的是 `{target-language}` / `{source-text}`，文案照搬、占位符按本条约定归一成渲染器认识的名字，否则原文根本不会被代入）。渲染用 `replaceAll`，不做转义——LLM 自身能处理特殊字符，用户填的模板我们尊重。Options 页面保存时如果模板缺占位符给软警告（仍允许保存）。一份 UI 设计稿把占位符画成 `{{text}}`/`{{target_lang}}`/`{{source_lang}}`（双括号 + 重命名 + 新增），**有意不采纳**：那只是设计稿的「样子」，改渲染会让所有用户已存的单括号模板失效（占位符不再被替换，译文里冒出裸 `{source_text}`），收益不抵破坏。`src/options/prompts.ts` 的预设文案也沿用单括号。

### System / User 双段 prompt：system 可选，空则退回单条 user
`renderPrompt` 之外，`translateViaLlm` 在 `config.system` 非空时多发一条 `{role:'system'}`（同样走 renderPrompt，里面也能用占位符）；空 system 时只发一条 user。两个 LLM 后端的默认 system 都是空（自定义端点曾默认一条"保留专有名词原文"的 system，2026-10 按用户要求清空）。已存过配置的用户不受默认值变化影响——`getConfig` 只给缺失的字段补默认。

### 自定义端点默认参数：`temperature 0` + 关 thinking，不设 `max_tokens`
`DEFAULT_CONFIG.custom.extraParams` 默认 `{"temperature": 0, "chat_template_kwargs": {"enable_thinking": false}}`，取自用户在用的 Index-Translate 模型卡（贪心解码、关思考）；默认 User 模板也是该模型卡的格式。`chat_template_kwargs` 是 llama.cpp server 的请求级字段（实测本地 server 接受），不是 OpenAI 标准——端点换成会拒绝未知字段的服务时要在 options 里删掉。不设 `max_tokens`，用服务端默认（llama.cpp 默认不限生成长度）。历史：早期照搬 Hy-MT2 模型卡示例的 `max_tokens: 128`，整页翻译长段落被截断，先后提到 1024、4096，2026-10 去掉；教训保留——若要填 `max_tokens`，同一份配置也供整页翻译，别给小了。DeepSeek 分支有自己的调优（`max_tokens 1024` + `thinking` 关），不受影响。

### 自定义端点默认指向本地 llama.cpp，UI 去掉 Ollama 字样
`DEFAULT_CONFIG.custom.endpoint` 默认 `http://127.0.0.1:8080/v1/chat/completions`（llama.cpp server 默认地址），新装即填好，本地起了服务就能直接用。options 文案与占位符里原先的 "Ollama" 提示、`11434` 端口、`qwen2.5:7b` 这类 ollama tag 写法全部移除（按用户要求弃用 Ollama），示例统一改成 llama.cpp 的 `8080` 与 `Qwen3-8B` 这类裸模型名。

### 语言中文名手写表 + Intl 兜底
`src/languages.ts` 手写 37 种 Hy-MT2 支持语言的 BCP-47 → 中文名映射（从模型卡复制）。手写比 `Intl.DisplayNames` 可控——`Intl` 把 `zh` 译为"汉语"而表里固定"中文"；某些少数语言 `Intl` 译名也有差异。`getLanguageDisplayName()` 先查表，没命中退到主子标签（`zh-CN` → `zh`），最后兜底 `Intl.DisplayNames`。

### 配置存 `chrome.storage.sync` + module-level 缓存 + onChanged 失效
跨设备同步；条目都很小（prompt 模板 ≪ 8KB 限额）。content / background / options 三个上下文共享，options 页面改完 background/content 通过 `chrome.storage.onChanged` 收到事件后清模块缓存——下次 `getConfig()` 重新读。不用每次翻译都打 storage（虽然很快，但能少就少）。

### 互译：选中文本与目标语言同族 → 翻向「另一边」，否则 → 翻向目标
目标语言现在是用户可配的 `config.targetLanguage`（默认 `zh-Hans`），不再写死。`pickTargetLanguage(source, primaryTarget)`（与 `reverseTarget` 一起放在无副作用的 `src/languages.ts`，options 的交换按钮也用它）用 `sameLanguageFamily()` 比较 BCP-47 主子标签（`zh-Hans` / `zh-CN` / `zh-TW` 同族）：同族就翻向 `reverseTarget(primaryTarget)`（目标是英语族则回译中文，否则回译英文），否则翻向目标。这样选英文/法文/任意外语都翻成中文、选中文翻成英文的便利保留下来，目标可改。源语言同理由 `config.sourceLanguage` 配置（默认 `'auto'`）：`resolveSourceLanguage()` 在非 auto 时直接用用户指定值跳过检测，划词/整页两条路径共用。**注意：绝不能让 `source === target`**——会让 resolveSourceLanguage 锁死源、pickTargetLanguage 判同族强行反向，方向错乱（见 pitfalls 的 swap 坑）。

### 检测置信度低 / `und` 时按英语兜底
LanguageDetector 对短文本置信度低或返回 `und`。直接按英语兜底，气泡里加"（源语言不确定，按英语翻译）"小提示。比直接报错有用。

### LanguageDetector 不可用时用启发式兜底（让 LLM 后端脱离 Chrome 内置 AI）
`detectLanguage()` 的唯一用途是 `pickTargetLanguage()` 二选一（译中 / 译英）。旧实现直接引用全局 `LanguageDetector`，浏览器没有 Chrome 内置 AI 时会抛 `ReferenceError`——DeepSeek/custom 这条本该独立于 Chrome 的后端路径反而走不通。改成 `typeof LanguageDetector === 'undefined'` 时走启发式（`translate/chrome.ts` 的 `detectLanguage` 开头）：含汉字按 `zh`、否则按 `en`，`uncertain: true`。粗略但够二选一；精确检测本来就依赖那个缺席的 API。Chrome 后端在 138+ 上行为不变（API 存在仍走 `LanguageDetector`）。

### 无总长度限制，只有 60s 单次创建超时
没有总文本长度上限。多段翻译靠换行切分逐段处理。`Translator.create()` 加 60s 超时（某些不支持的语言对会让 create 永远 hang）。

### iframe 内不工作（`all_frames: false`）
早期试过 `all_frames: true` 但跨域 iframe 调 Translator API 需要父页面给 iframe 加 `allow="translator"` 权限策略（浏览器策略，扩展绕不过）。AWS 等多 iframe 站点都没加——`true` 只是让触发器在 iframe 里出现但点了报错，反而误导用户。索性关掉。

### `<input>` / `<textarea>` 选区粗略定位到输入框右下角
精确到光标需要 mirror-div 技巧，复杂度过高。post-MVP 再考虑。

### 整页翻译：再次右键 = 取消，靠 sessionId 拦截 in-flight 回调
菜单只有一项"翻译整页（沉浸式）"，行为是 toggle：未启动则翻译，已启动则停 observer、清队列、移除所有 `.tnyl-translation` 节点和 `data-tnyl-translated` 标记。in-flight 翻译没法 cancel（Translator.translate 不接 AbortSignal），用 `sessionId` 计数器：每次 start/stop 都 `++`，task 完成时 session 不匹配就 return，不写回 DOM。menu title 不动态切换（要让 background 知道 per-tab 状态太复杂），用户点两次自然就理解。

### 整页翻译暂不支持 SPA 路由重扫
SPA 切路由后不自动翻译新页面：监听 `currententrychange` 只做清场（清掉上一页残留的译文，见 pitfalls），新页面要再次右键触发。自动续翻需要 MutationObserver 盯内容替换，等用户反馈再考虑。

## 错误处理

### 错误信息用中文，语言名走 `getLanguageDisplayName`
Chrome 原始错误是英文（"Unable to create translator..."）。捕获后把 BCP 47 代码（`is`）转成中文名（"冰岛语"）再拼进中文错误，原始错误保留在 `console.error`。语言名统一用 `src/languages.ts` 的 `getLanguageDisplayName`（手写表优先、`Intl.DisplayNames` 兜底），不再在 Chrome 后端里另写一份只用 Intl 的版本——LLM prompt 和错误信息里的语言名因此一致。

### Session ID 取消失效请求
每次选区/触发器创建都 `++currentSessionId`。异步操作开始时记下自己的 session，回调里 session 不等于当前就 return。避免快速连续操作时旧结果覆盖新结果。

## 隐私 / 法律

### MIT License
最宽松，发扩展最常见。

### 不联网、不收集、不上报
扩展不调任何远端服务、不上报使用数据、不读敏感信息。翻译完全本地完成，模型下载由 Chrome 自身完成（不是扩展）。Chrome 商店审核硬性要求隐私声明，写在 README 里。
