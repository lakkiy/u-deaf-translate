<p align="center">
  <img src="design/icon-1024.png" width="180" alt="叫你翻译你聋吗" />
</p>

<h1 align="center">叫你翻译你聋吗 · u-deaf-translate</h1>

<p align="center">
  选中网页文字 → 自动翻译为中文。<br />
  <i>Translate selected text to Chinese, fully on-device.</i><br />
  基于 <b>Chrome 138+ 内置 Translator API</b>，全本地推理，零联网。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/chrome-138%2B-brightgreen" alt="Chrome 138+" />
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT License" />
</p>

---

一个极简的 Chrome 扩展：选中网页上的文字，浮出一个红色"译"按钮，点击后原地展开成翻译气泡显示中文译文。完全基于 Chrome 内置 Translator API（本地推理，不联网调用云服务），首次使用某个语言对会下载几十 MB 的模型，之后离线可用。

## 系统要求

- **Chrome 138 或更高版本**（在地址栏输入 `chrome://version` 检查）
- 桌面平台：macOS / Linux / Windows / ChromeOS（移动端不支持）
- 系统空闲存储 ≥ 22 GB（首次下载模型时需要）

## 安装并跑起来

```bash
bun install        # 装依赖
bun run build      # 输出生产构建到 dist/
```

然后在 Chrome 里加载这个扩展：

1. 打开 `chrome://extensions`
2. 右上角开启 **「开发者模式」**
3. 点 **「加载已解压的扩展程序」**，选这个项目里的 `dist/` 目录
4. 随便打开一个英文网页（比如 https://en.wikipedia.org/wiki/Cat ）
5. 选中一段文字 → 鼠标指针旁浮出一个小小的红色"译"图标
6. 点击图标 → 原地变成 spinner（短翻译会跳过 spinner），翻译完成后展开成气泡显示中文译文
7. **首次翻译**会下载几十 MB 的模型，下载进度在 DevTools console 里输出（`[叫你翻译你聋吗] 下载翻译模型: X%`），下完才出译文；同一语言对之后秒翻
8. 气泡颜色自动跟随系统主题（亮色系统 → 白底；暗色系统 → 深底）

## 开发模式（自动热重载）

```bash
bun run dev
```

Vite + CRXJS 会监听源码变更并自动重建。改完代码不需要在 `chrome://extensions` 里手动点刷新（content script 的 HMR 由 CRXJS 注入处理）。如果偶尔卡住没刷新，去 `chrome://extensions` 点扩展卡片上的刷新按钮就行。

## 项目结构

```
.
├── manifest.json           # MV3 清单，声明唯一一个 content script
├── package.json            # 依赖 + 脚本
├── tsconfig.json           # TS 严格模式 + chrome 类型
├── vite.config.ts          # @crxjs/vite-plugin 接入
└── src/
    ├── content.ts          # 入口：选区监听、串联检测/翻译/气泡
    ├── translator.ts       # 封装 Translator + LanguageDetector，缓存实例
    └── bubble.ts           # Shadow DOM 气泡 UI（show / hide）
```

只有 3 个源文件，加起来 ~250 行。所有翻译相关 API 都在 content script 里调，
**没有 service worker、没有消息传递**——因为 Chrome 的 Translator API 不能在
Worker 上下文调用，而 MV3 service worker 本质就是 worker。

## 已知限制（MVP 范围内）

- 目标语言写死为简体中文（`zh-Hans`），还没做选项页
- 只在顶层页面工作（manifest `all_frames: false`）。iframe 内的选区不会触发——曾试过 `all_frames: true`，但跨域 iframe 调 Translator API 需要父页面给 iframe 元素加 `allow="translator"` 权限策略（浏览器层面的限制），AWS Console 等多 iframe 站点都没给，结果只是触发器在 iframe 里出来但点了报错，反而误导用户，索性关掉
- `<input>` / `<textarea>` 里的选区气泡定位到输入框右下角，不精确到光标位置（精确实现需 mirror-div 技巧）
- 滚动页面时气泡直接关闭（不跟随选区滚动），类似系统词典弹窗
- 选区少于 2 字符不触发；长文本按换行切分逐段翻译，无总长度限制

## 调试技巧

- 查看 content script 的 console：随便打开一个普通网页，按 F12 打开 DevTools，
  console 里看到的就是 content script 的输出（content script 共享页面的 console）
- 重新加载扩展：`chrome://extensions` → 扩展卡片上的刷新按钮
- 看 Vite 构建错误：终端里 `bun run dev` 的输出
- 测试模型尚未下载时的 UX：`chrome://components` 里找 "Optimization Guide On Device Model" 卸载

## 隐私

**本扩展不收集、不存储、不上传任何用户数据。**

- 所有翻译在用户本地通过 Chrome 内置 AI 完成，整个翻译过程**不联网**
- 唯一一次联网是首次使用某个语言对时下载语言模型——这步由 Chrome 浏览器自身完成，扩展不参与
- 扩展不读取浏览器历史、Cookie、表单数据、任何敏感信息
- 不使用任何第三方服务、不上报任何使用统计、不内置广告或追踪
- 没有后端服务器、没有云端 API、没有 API key

## 参考链接

- [Chrome Translator API 文档](https://developer.chrome.com/docs/ai/translator-api)
- [Chrome Language Detector API 文档](https://developer.chrome.com/docs/ai/language-detection)
- [Chrome 扩展入门](https://developer.chrome.com/docs/extensions/get-started)
- [@crxjs/vite-plugin](https://github.com/crxjs/chrome-extension-tools)

## License

MIT © lakkiy
