# 正文识别算法回归测试集

这是 `src/content/page-content.ts`（`findContentRoot` + `collectParagraphs`，整页沉浸式翻译的
正文识别算法）的离线回归测试集。用真实网页样本固定当前行为，改算法后一眼看出有没有
把原本收得好的页面搞坏。完整算法设计见 `docs/content-detection.md`。

不是单元测试断言——没有"通过/失败"这种自动判定，而是把算法输出存成文本快照，
靠 `git diff` 让改动可见，再由人读 diff 判断是改进还是回归。

## 目录结构

- `eval.ts` —— 评测 harness，用 [linkedom](https://github.com/WebReflection/linkedom)
  把 HTML 解析成 `document`，挂到 `globalThis.document`，再 import 项目里的
  `src/content/page-content.ts` 跑算法。
- `pages/*.html` —— 页面样本（20 个）。
- `results/*.txt` —— 每个样本对应的算法输出快照（checked in，作为基线）。

## 怎么跑

```bash
bun run eval
```

无参数时会遍历 `eval/pages/*.html` 全部重新跑一遍，覆盖写入 `eval/results/` 下同名
`.txt`。也可以只跑一个页面：

```bash
bun eval/eval.ts eval/pages/wikipedia_alan_turing.html
```

跑完看 `git diff eval/results/`：

- **diff 干净** —— 本次改动没有影响这 20 个样本的行为，没有引入回归。
- **有 diff** —— 逐条人工判断：这一行是新收进来的正文（改进）还是新泄漏的垃圾
  （回归）？是原来收的正文消失了（回归）还是原来的垃圾被过滤掉了（改进）？
  确认都是预期改动后，把新的 `results/*.txt` 一并提交。

输出格式是确定性的（没有时间戳、没有随机数），同样的算法 + 同样的页面必然产生
字节级相同的输出，这是 diff 能用来判断回归的前提。

## 如何收录新页面

用户反馈某个页面正文识别有问题时，按下面的流程处理：

1. 抓页面存下来（`<Chrome UA>` 替换为下面这行完整字符串）：

   ```bash
   curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
     <url> -o eval/pages/<站名_简述>.html
   ```

   文件名用 `<站名>_<简述>.html`，例如 `guardian_article.html`、`hn_item_48776044.html`。

2. 跑 `bun run eval`，会生成对应的 `eval/results/<站名_简述>.txt`。

3. 人工核对这个新页面的 results txt：
   - root 对不对（是不是选到了真正的正文容器，而不是整个 `<body>` 或某个侧栏）；
   - 有没有漏收（对照原始 HTML，正文段落是不是都在输出里）；
   - 有没有多收（导航、广告、推荐位、CTA 等噪声是不是混进来了）。

   把观察到的问题现象（哪个 root 错了、漏收了什么、多收了什么）记进 commit message，
   如果是有代表性的坑，记进 `docs/pitfalls.md`。

4. 按需要修改 `src/content/page-content.ts`，重跑 `bun run eval`，确认：
   - 新页面的问题确实改善了；
   - 其余 18 个老页面的 `results/*.txt` 没有产生非预期的 diff（无回归）。

   新样本（`pages/*.html`）和新基线（`results/*.txt`）随代码改动一起提交。

5. 注意：JS 渲染的站点（例如新版 www.reddit.com、docs.agora.io）用 `curl` 抓不到
   真实渲染后的 DOM，只能拿到反爬虫空壳或者客户端渲染前的骨架（几 KB 就是信号）。
   这类站点优先用无头 Chrome 渲染后 dump（`--user-data-dir` 指向临时目录，避免和
   正在运行的 Chrome 抢同一份 profile）：

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless=new --disable-gpu --user-data-dir=/tmp/chrome-eval-profile \
     --virtual-time-budget=15000 --dump-dom <url> > eval/pages/<站名_简述>.html
   ```

   有反爬虫拦截无头浏览器的站点，退回手动方案：浏览器里打开页面、等 JS 渲染完成后，
   用 DevTools 的"另存为"或"Copy outerHTML"拿到渲染后的 HTML，再存进 `eval/pages/`。
