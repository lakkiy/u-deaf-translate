# 已踩过的坑

记录开发中遇到的非显然问题及其修复——避免下次重复踩。每条三段：现象 / 真相 / 修复。

## Translator API

### Translator API 不能在 Web Worker 中调用
- **现象：** 一开始考虑把翻译放到 service worker 里（MV3 后台脚本）。
- **真相：** MV3 service worker 本质是 Web Worker，而 Translator API 明确不支持 Worker 上下文。
- **修复：** 所有翻译逻辑都放 content script。

### Translator.create 在模型已缓存时也会触发一次 `downloadprogress=1`
- **现象：** 每次翻译时进度条都会闪一下，即使是已缓存的模型。
- **真相：** Chrome 在 create 完成时也会触发 monitor 的 downloadprogress 事件，progress 值为 1。
- **修复：** `if (progress >= 1) return;` 跳过等于 1 的事件。

### Translator.create 在不支持的语言对上会无限挂起
- **现象：** 测试冰岛语时翻译永远不返回，UI 卡在 spinner。
- **真相：** API 在不支持的语言对上有时既不抛错也不 resolve。
- **修复：** `Promise.race` 加 60s 超时兜底，超时显示中文错误。

### 直接传含换行的整段文本会被压平成一行
- **现象：** 选两段英文翻译，译文混成一大段，原本的段落结构丢了。
- **真相：** Translator 把 `\n` 当成普通空白处理，输出里全部被压成空格。
- **修复：** `text.split(/(\n+)/)`（capturing group 保留分隔符），逐段调 translate，再原样拼回。

### 跨域 iframe 调 Translator 需要 `allow="translator"` 权限策略
- **现象：** 试过 `all_frames: true`，但 AWS Console 等多 iframe 站点点了触发器还是失败。
- **真相：** 跨域 iframe 调 Translator API 需要父页面在 iframe 元素上加 `allow="translator"`。AWS、嵌入式编辑器等不会加。
- **修复：** 改回 `all_frames: false`。这是浏览器策略，扩展绕不过——文档里写清楚。

### 错误信息默认是英文
- **现象：** 不支持的语言对返回 "Unable to create translator for the given source and target language."
- **修复：** 捕获后用 `Intl.DisplayNames(['zh-Hans'], { type: 'language' })` 把 BCP 47 代码转成中文名，抛"暂不支持「冰岛语」翻译为简体中文"。原始错误用 `console.error` 保留。

### DeepSeek 当前 endpoint 是 `/chat/completions`（无 `/v1`），翻译要主动 disable thinking
- **现象：** 之前按 OpenAI 惯例填 `https://api.deepseek.com/v1/chat/completions`；模型名也凭印象用 `deepseek-chat` / `deepseek-reasoner`。
- **真相：** 官方文档（api-docs.deepseek.com/zh-cn/api/create-chat-completion）当前路径是 POST `/chat/completions`（无 `/v1`），且 model 可选值只列了 `deepseek-v4-flash` / `deepseek-v4-pro`。文档同时定义了 `thinking: { type: "enabled" | "disabled" }`，默认 enabled——pro 模型默认开思考会显著拖慢响应、且响应里可能混入 reasoning 内容污染译文。
- **修复：** `DEEPSEEK_ENDPOINT` 改成 `https://api.deepseek.com/chat/completions`；`DEEPSEEK_EXTRA_PARAMS` 加 `"thinking": {"type": "disabled"}`。教训：第三方 API 不要按 OpenAI 惯例脑补 endpoint，去文档确认。

### `mlx_lm.server` 收到不匹配的 `model` 字段会尝试 download 然后 404
- **现象：** 配了本地 mlx_lm endpoint，翻译报 `HTTP 404: {"error": "[Errno 2] No such file or directory: 'config.json'"}`。启动参数：`mlx_lm.server --model mlx-community/Hy-MT2-1.8B-4bit`。
- **真相：** mlx_lm.server 每个请求都检查 `model` 字段，跟当前加载的不一致就尝试重新 load——若 model 名不存在（或 placeholder 误导用户填错）就找不到 `config.json` → 404。问题不在 max_tokens 之类的生成参数，纯粹是 model 名问题。
- **修复：** llm-backend 改成"model 留空就不发该字段"，让 server 直接用当前加载的；options 页面 placeholder 改成完整 model 名 `mlx-community/Hy-MT2-1.8B-4bit` 避免误导。

### `Translator.translate()` 对极短/无效输入抛 "Other generic failures occurred."
- **现象：** 划词选了 "Thu"（星期缩写）/ 时间戳 / 单符号，气泡里直接显示原始英文 "Other generic failures occurred."。
- **真相：** Chrome Translator API 的兜底错误信息。原本错误处理只包了 `Translator.create()` 的 catch，`translate()` 本身的异常直接 propagate 到气泡。
- **修复：** `translate()` 内的循环加 try/catch，调 `friendlyTranslateError(rawMessage, sourceLanguage)` 把已知英文模式映射成中文（"无法翻译这段文本（可能太短或不是有效的英语内容）"），原始错误保留在 `console.error`。同时映射了 "not available / unavailable" → "翻译服务暂不可用"。

### Chrome service count 限制按"alive 实例数"算，不是按调用次数
- **现象：** 翻几个网页之后，新页面所有翻译都失败。控制台出现 Chrome 黄色 warning `The translation service count exceeded the limitation.`，紧跟着 `NotSupportedError: Unable to create translator for the given source and target language.` 重启 Chrome 后又恢复。
- **真相：** Chrome Translator API 的 service count 配额计的是 **当前 alive 的 `Translator` 实例数**，不是调用次数。JS 端引用被 GC 不会自动减少 Chrome 内部计数器——**必须显式调 `translator.destroy()`**。否则每个页面 create 一次永不释放，浏览几个页面后就累计到上限。
- **修复：**
  1. 维护 `liveTranslators: Set<TranslatorInstance>` 和 `liveDetector` 引用，create 成功后写入
  2. `pagehide` → `destroyAll`：页面卸载/导航释放
  3. 仍保留 `successfulPairs` 做友好错误信息的依据：本 session 内成功过的 pair 现在失败，必然是页内连续翻译耗尽配额

  教训：Chrome 内置 AI 的实例必须显式 destroy，不能依赖 GC。

### `pagehide` 不够：多 tab 时切走 tab 不会触发
- **现象：** 修了 destroy on pagehide 之后，仍然在某个 tab 里看到 `service count exceeded`。
- **真相：** `pagehide` 只在页面真的卸载或导航时触发。**用户切到别的 tab 时 pagehide 不会发**——其他 tab 持有的 Translator 实例依然 alive，占着 Chrome 全局 service count 配额，新 tab 的 create 就被卡住。
- **修复：** 同时监听 `document.visibilitychange`，`visibilityState === 'hidden'` 时也 `destroyAll`。代价是切回来时第一次翻译要重新 create（~100ms），但比"翻不动"好得多。

### 限速时连点重试反而把 count 推得更高
- **现象：** 翻译失败后用户连点 4-5 次，每次都出新的 `Translator.create 失败`，控制台堆了 4-5 条。
- **真相：** `getTranslator` 缓存的失败 promise 在 `.catch` 里被立即 `delete`。下一次点击 cache miss，立即又 `Translator.create()`——而失败的 create 本身可能也消耗配额。
- **修复：** 失败后延迟 3 秒（`FAILED_RETRY_COOLDOWN_MS`）才从 `translatorPromises` 删除。3 秒内的所有重试共享同一个被拒 promise，错误立即返回，不再触发新 create。

### `Translator.availability()` 在限速时也"撒谎"
- **现象：** 尝试用 `Translator.availability(...)` 作为"真不支持"的可靠判定（限速时 create 失败，availability 总该返回真相吧？）。结果速率限制触发后，控制台出现 `The on-device translation is not available.`——availability 对所有语言对一律返回 `'unavailable'`，根本不能区分"真不支持"和"被限速"。
- **真相：** Chrome 内置 AI 的所有 API（create / availability）共享同一个速率配额，被限速时一并失活。
- **修复：** 撤掉 availability 判定。只靠 `successfulPairs` 作为精确信号，其他情况走"双因"模糊消息。教训：Chrome 内置 AI 的状态查询 API 在限速场景下不可信。

## 整页翻译 — 正文识别

### Web app 页面的 `<main>` 把侧栏也囊括了
- **现象：** HuggingFace model 卡右键整页翻译，右侧 sidebar 里的 "Files info"、"Safetensors"、"Model tree for ..." 也被翻了。
- **真相：** HF 把 README 左栏和元数据右栏放在同一个 `<main>` 下，且把 `<article>` 用在右栏（`overview-card-wrapper`）而不是 README——简单的 `<main>` / `<article>` 优先级判断都选错。
- **修复：** `findRoot()` 选完 seed 后用所有 `<p>` 的 LCA 收敛。HF sidebar 几乎没 `<p>`，LCA 自然落到 README。**但很快又踩了下一条坑（GitHub）：LCA 只要侧栏有 1 个 `<p>` 就会被拉宽。**最终改成"80% 覆盖最深子树"策略，见下条。

### GitHub Discussion 把 metadata 包在 `<h3>` 里，候选直接被吃进去
- **现象：** GitHub Discussion 页（`https://github.com/orgs/community/discussions/...`）整页翻译后，每条评论顶部的 "spenserblack May 21, 2025" 被翻成 "斯宾塞·布莱克 2025年5月21日"，"Replies: 5 comments" 被翻成 "5条评论" 之类。
- **真相：** GitHub 把评论头的"用户名 + 时间戳"放进 `<h3>` 标签（用户名是一个 `<a>`、时间戳是另一个 `<a>`，整个 h3 几乎全是 link 文字）。`<h3>` 是我们的候选段落标签，自然被收。
- **修复：** `collectParagraphs` 加 `isMostlyLinks(el)` 过滤——候选元素的 textContent 有 ≥70% 来自 `<a>` 子节点就跳过。正常正文段落里 inline link 不会到 70%，metadata 行近 100%。同时在 console.log 里打出 root 信息（tag/id/class），方便下次有页面识别异常时反查。

### LCA 被侧栏里一个 `<p>` 拉宽到 main
- **现象：** GitHub repo 页（`https://github.com/earendil-works/pi`）右键整页翻译，右侧 About sidebar 里的 "Resources / Readme / MIT license / Contributing / 55.1k stars / 198 watching / 6.5k forks" 全被翻成"资源 / 执照 / 星星 / 观察者 / 叉子"。
- **真相：** GitHub About sidebar 里有 1 个 `<p>`（项目描述那段长文本）。LCA 算法对所有 `<p>` 取最小公共祖先——sidebar 一个 + README 18 个 = 19 个 `<p>` 的 LCA = 包含两者的 `<main>`，等于没收敛。
- **修复：** 弃 LCA，改成"**最深的子树包含 ≥ 80% 有效 `<p>`**"。GitHub: README article 占 18/19 = 94% ≥ 80%，被选中；sidebar 1/19 = 5% 远不够。HF: README section 占绝大多数 `<p>`，同样命中。"最深"保证最窄。代价是当真正的正文被拆到两个并列容器（每个都 < 80%）时会回退到 seed——目前没遇到这种页面。

### `<table>` 单元格 `textContent` 把 `<code>` 子节点的代码也吞了
- **现象：** corrode.dev 一个对比表，"Go tool / Rust equivalent" 列里 `<td>` 含 `<code>go build</code>`，整段翻译得到"去建造"、"货物建造"。
- **真相：** `<td>` 是候选段落，`isExcluded` 只查祖先标签——`<td>` 内的 `<code>` 是子节点不是祖先，`textContent` 把代码字符也提走了。
- **修复：** PARAGRAPH_TAGS 删 `td`，EXCLUDE_TAGS 加 `TABLE`。代价是表格里的英文长说明也不翻——按用户反馈整张表跳过更可控。

## 整页翻译 — 运行时

### 源语言检测的 rejected promise 被永久缓存，毒化整页
- **现象：** 整页翻译某次检测失败后，该页之后每一段、每次重新 toggle 都显示"[翻译失败]"，刷新前不恢复。
- **真相：** `getSourceLanguage` 把 `detectLanguage()` 的结果存成单例 `detectedLanguagePromise` 供全页复用；失败时存进去的是 rejected promise，之后每段 `await` 的都是同一个被拒 promise。
- **修复：** `detectedLanguagePromise.catch(() => { detectedLanguagePromise = null; })`——失败不缓存、下次重新检测；成功结果仍按设计全页复用。

### stop/start 竞态残留"翻译中…"孤儿节点
- **现象：** 取消整页翻译后，偶尔有段落下方永久留着"翻译中…"占位。
- **真相：** `translateParagraph` 先插入 pending 节点再 `await` 检测/翻译。若某任务恰在 `stopPageTranslation()` 扫除节点之后才插入、随后 `sessionId` 失配直接 `return`，这个 pending 节点就没人清。
- **修复：** 三处 `mySession !== sessionId` 的 return 前都补 `node.remove()`。

### SPA 站内跳转后 `started` 残留，新页面第一次右键不翻译
- **现象：** 在一个页面右键"翻译整页"，然后跳到同站另一页再右键，第一次没反应，点第二次才翻译。
- **真相：** ghostty.org 等 Next.js 站点站内跳转是客户端路由，**不重载 content script**，`page-translator.ts` 模块级的 `started` 从上个页面残留成 `true`。新页面第一次 `togglePageTranslation()` 因此走的是 `stopPageTranslation()`（清残留状态，新页面没译文可清，看不到效果），第二次才 `startPageTranslation()`。整页全量加载到别的站点时 content script 会重载、`started=false`，所以问题只在 SPA 站内跳转出现。
- **修复：** 启动时记下 `startedHref = location.href`，`togglePageTranslation()` 里若 `started && location.href !== startedHref` 就先 `stopPageTranslation()` 清掉旧 session，再当未启动重新开始。（注：未监听导航事件——content script 在隔离世界 patch `history.pushState` 收不到页面自身的调用，故改成 toggle 时惰性比对 URL。代价是 A→B→A 回到同一 URL 的罕见情形仍会残留。）

## DOM / CSS

### 父容器是 flex/grid 时，译文 `afterend` 兄弟节点被挤到原文右边
- **现象：** ghostty.org/docs/config 的标题"Syntax"整页翻译后，译文"语法"出现在标题**右侧**而非下方，中间还有一条竖线（其实是译文节点的 `border-left`）。
- **真相：** 该站标题结构是 `<div display:flex><h3>Syntax</h3><a>锚点复制按钮</a></div>`。译文默认用 `insertAdjacentElement('afterend')` 插在 `<h3>` 后做兄弟节点，于是它变成那个 flex 容器里的**另一个 flex item**，被排进同一行。译文节点的 `display:block` 在 flex 格式化上下文里不起换行作用。
- **修复：** `page-translator.ts` 新增 `insertTranslationNode()`，检测原文父容器的 computed `display` 为 `flex/inline-flex/grid/inline-grid` 时，改用 `el.appendChild` 把译文塞进原文元素内部当末尾块级子节点，靠原文自身的块级布局换行到下方；其余情况维持 `afterend`。这同时更贴合 `font: inherit`「译文字号跟原文一致」的本意——标题译文会跟标题同样大小。

### CSS `background: rgba(...)` 替换而非叠加
- **现象：** trigger 的 hover 状态用 `--hover-bg: rgba(0, 0, 0, 0.06)`，鼠标悬停时气泡看起来"消失"。
- **真相：** `background: var(...)` 直接替换了原本的实色背景，半透明的 rgba 让气泡变得几乎透明。
- **修复：** 改用实色 `#f0f0f0`（亮）/ `#2c2c2c`（暗）。后来又改成 `transform: scale` 完全不动 background。

### Selection.toString() 在跨块级元素时插入 \n
- **关联坑：** 上面那条"换行压平"的根源。
- **真相：** 跨段选区取 toString 时，浏览器在块级元素间插入 `\n`——这是为什么需要按换行切分。

### HTML 里的 \n 不会渲染成换行
- **现象：** 切分翻译后拼回，发现气泡里译文还是连在一起的。
- **真相：** HTML 默认把 `\n` 当普通空白处理，连续空白折叠成单个空格。
- **修复：** 译文容器加 `white-space: pre-wrap`。

### 气泡内滚动会触发 window scroll，把气泡自己关掉
- **现象：** 长译文在气泡里上下滚，气泡一滚就消失。
- **真相：** 没设 overflow 时滚轮事件透传到 window，触发我们的 scroll → hide 监听。
- **修复：** 气泡加 `max-height: 60vh` + `overflow-y: auto` + `overscroll-behavior: contain`。

### 内部可滚动容器的滚动收不到，气泡不关
- **现象：** 在页面内 `overflow:auto` 的子容器里滚动，划词气泡不消失（只有滚动整个 window 才关）。
- **真相：** `scroll` 事件不冒泡，`window` 上不带 capture 的监听只能收到 document 滚动，收不到内部容器的滚动。
- **修复：** `window` 的 scroll 监听加 `capture: true`（捕获阶段会经过 window）。但这会顺带收到气泡自身滚长译文的 scroll——必须在 handler 里 `if (isEventInsideBubble(event)) return;` 排除，否则滚译文会把气泡自己关掉（与上一条 `overscroll-behavior` 防的是不同传播路径）。

### `<input>` / `<textarea>` 里的选区不在 `window.getSelection()` 中
- **现象：** 输入框里选中的文字无法触发翻译。
- **真相：** 表单字段的选区单独存在 `element.selectionStart` / `selectionEnd`，不是 document 的选区。
- **修复：** 检查 `document.activeElement` 是不是 HTMLInputElement/HTMLTextAreaElement，单独取 `value.slice(start, end)`。

### Closed Shadow DOM 的 event.target 被重定位到 host
- **现象：** 想判断点击是否在气泡内部，`event.target === bubbleEl` 永远 false。
- **真相：** 事件穿过 closed shadow root 时 target 被 retarget 到 host 元素。
- **修复：** 用 `event.composedPath().includes(hostEl)` 判断。

### body 在 document_start 时可能还不存在
- **现象：** 气泡 host 元素加到 body 时偶尔报 null。
- **修复：** 加到 `document.documentElement` 而非 body，更早且总是存在。

### 触发器位置用 BUBBLE_MAX_WIDTH 估算导致离鼠标太远
- **现象：** 鼠标在页面右侧选词，触发器跑到 360px 远的左侧。
- **真相：** 为了避免触发器→气泡状态切换时位置跳变，定位用 `BUBBLE_MAX_WIDTH` 估算宽度做翻转。代价是只有 32px 的触发器也按 360px 来定位。
- **修复：** 改用实际渲染宽度。状态切换时气泡沿同一侧延展（右翻则右边缘对齐），不会大幅跳变。

## TypeScript / 构建

### 自定义 `Selection` 接口与 DOM 全局类型冲突
- **现象：** 在 content.ts 定义 `interface Selection { text, rect }`，TS 不报错但读起来困惑（全局 DOM 的 Selection 是不同的类型）。
- **修复：** 重命名为 `SelectionInfo`，避免和全局类型重名。

### Vite 的 `?inline` query 默认无 TS 类型
- **现象：** `import iconUrl from './icon.png?inline'` 报 TS 类型错误。
- **修复：** tsconfig 的 `types` 加 `"vite/client"`，包含 Vite 的资源类型声明。

### Bun 单独做 Chrome 扩展工具链不全
- **现象：** 一开始考虑纯 bun 打包，发现没有 HMR、没有 manifest 自动处理。
- **修复：** 改用 Bun（包管理）+ Vite + @crxjs/vite-plugin。CRXJS 自动处理 manifest 引用、HMR 接好。

## 体验细节

### 选区 < 2 字符 / 过快连选触发闪烁
- **修复 1：** 长度阈值 2 字符以下不触发。
- **修复 2：** mouseup → 150ms 防抖才显示触发器；期间新事件清掉定时器重排。

### 短翻译时 spinner 一闪而过
- **现象：** 缓存命中的短翻译先闪一下 spinner 再变译文，视觉抖动。
- **修复：** spinner 显示加 200ms 延迟 + `finally { clearTimeout }`。<200ms 完成的翻译根本看不到 spinner。

## AI 模型行为

### LanguageDetector 对短文本置信度低 / 返回 `und`
- **现象：** 选单词或几个字符时检测结果不可信。
- **修复：** 置信度 < 0.5 或返回 'und' 时默认按英语兜底，气泡加"（源语言不确定）"提示。

## 浏览器限制（无解 / 设计绕过）

### Chrome 内置 PDF viewer 内 content script 不注入
- **现象：** PDF 文件里选词没反应。
- **真相：** PDF viewer 本身是 Chrome 的特殊扩展，content_scripts 注入不进去。
- **状态：** 无法解决（除非自己实现 PDF 解析），README 里标记为已知不支持。

### `chrome://` / 商店页 / `chrome-extension://` content script 不注入
- **状态：** Chrome 自身规则，无法绕过。预期不工作即可。
