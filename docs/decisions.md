# 设计决策与技术选型

记录"为什么这么做"——避免以后回头时重新讨论同一个问题。每条决策一段，含上下文和理由。

## 架构

### 单 content script，无 service worker
Chrome Translator API 不能在 Worker 上下文调用，而 MV3 service worker 本质就是 worker——直接排除了把翻译放后台的方案。content-script-only 同时省掉了消息传递的开销，是最易读的实现。

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

## 样式

### 跟随系统主题
`:host` 上用 CSS 变量定义颜色，`@media (prefers-color-scheme: dark)` 覆盖一组暗色值。无需 JS 干预，跟随系统切换实时生效。

### 气泡内部可滚动 + `overscroll-behavior: contain`
长译文气泡限高 60vh + `overflow-y: auto`。`overscroll-behavior: contain` 防止滚到底/顶后滚动事件传到页面（否则会触发 window scroll 把气泡关掉）。

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

### 目标语言写死 zh-Hans
主用户是中文读者，不做语言选项页（MVP 范围）。

### 检测置信度低 / `und` 时按英语兜底
LanguageDetector 对短文本置信度低或返回 `und`。直接按英语兜底，气泡里加"（源语言不确定，按英语翻译）"小提示。比直接报错有用。

### 无总长度限制，只有 60s 单次创建超时
没有总文本长度上限。多段翻译靠换行切分逐段处理。`Translator.create()` 加 60s 超时（某些不支持的语言对会让 create 永远 hang）。

### iframe 内不工作（`all_frames: false`）
早期试过 `all_frames: true` 但跨域 iframe 调 Translator API 需要父页面给 iframe 加 `allow="translator"` 权限策略（浏览器策略，扩展绕不过）。AWS 等多 iframe 站点都没加——`true` 只是让触发器在 iframe 里出现但点了报错，反而误导用户。索性关掉。

### `<input>` / `<textarea>` 选区粗略定位到输入框右下角
精确到光标需要 mirror-div 技巧，复杂度过高。post-MVP 再考虑。

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
