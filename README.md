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

## 系统要求

- Chrome 138+ 桌面版（macOS / Linux / Windows / ChromeOS，移动端不支持）
- 系统空闲存储 ≥ 22 GB（首次下载翻译模型用）

## 安装

```bash
bun install
bun run build
```

`chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `dist/`。

## 使用

选中网页文字 → 鼠标旁出现红色"译"图标 → 点击 → 气泡显示中文译文。

首次使用某语言对时会下载模型（几十 MB，进度在 DevTools console 里输出），下完才出译文，之后秒翻。气泡颜色跟随系统亮/暗主题。

## 开发

```bash
bun run dev    # HMR 自动重建
bun run pack   # 打包成可上传商店的 zip
```

## 隐私

不收集、不存储、不上传任何用户数据。翻译完全本地完成，扩展不联网、不读取敏感信息、不使用第三方服务、不内置广告或追踪。

## 参考

- [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api)
- [Chrome Language Detector API](https://developer.chrome.com/docs/ai/language-detection)
- [@crxjs/vite-plugin](https://github.com/crxjs/chrome-extension-tools)

## License

MIT © lakkiy
