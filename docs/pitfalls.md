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

### Chrome 触发速率限制后伪装成 `NotSupportedError`
- **现象：** 之前一直能翻的英文，连续翻多次后突然全部报"暂不支持「英语」翻译"。控制台同时出现 Chrome 的黄色 warning `The translation service count exceeded the limitation.`，紧跟着 `NotSupportedError: Unable to create translator for the given source and target language.`
- **真相：** Chrome Translator API 内部有 service count 速率限制（即使是本地推理，Chrome 也按 origin 计数防滥用）。短时间翻译过多后会拒绝新的 `Translator.create()`，且复用 `NotSupportedError`——错误对象上看不出是"真不支持"还是"被限速"。
- **修复：** 三层判断在 `createTranslator` 的 catch 里：
  1. `successfulPairs` Set 记录本 content script 实例里成功过的 pair——如果命中，必然是页内连续翻译触发限速，抛"Chrome 翻译次数超限"
  2. 否则调 `Translator.availability({ sourceLanguage, targetLanguage })` 探查。返回 `'unavailable'` 才是真不支持
  3. availability 返回支持或方法不可用 → 抛模糊但诚实的"可能限速或不支持"消息

  `successfulPairs` 仅内存维护，跨页面会丢，所以需要 availability() 作为二次判定。早期只靠 successfulPairs 时，新页面的第一次失败会被误判成"不支持"。

## DOM / CSS

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
