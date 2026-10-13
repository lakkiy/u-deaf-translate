// 全页沉浸式翻译：识别正文段落 → 滚动到视口时翻译 → 译文插在原文下方。
// 与划词翻译共存：复用 translate/ 的实例缓存、语言检测。
// 一次 startPageTranslation() 只识别一次正文，IntersectionObserver 注册到所有候选段落。
// 正文识别算法（findContentRoot / collectParagraphs）见 page-content.ts。

import { resolveSourceLanguage, translate } from '../translate/translate';
import { findContentRoot, collectParagraphs, paragraphText } from './page-content';

const MARKER_ATTR = 'data-tnyl-translated';
const TRANSLATION_CLASS = 'tnyl-translation';
const STYLE_ID = 'tnyl-page-translation-style';
const MAX_CONCURRENT = 3;

// 当前是否已启动整页翻译
let started = false;

// 启动整页翻译时的 URL。SPA（Next.js 等客户端路由）站内跳转不会重载 content script，
// 模块级的 started/observer 会从上个页面残留下来，插进 DOM 的译文节点也会被
// 框架复用的容器留在新页面上。下方的 currententrychange 监听拿它跟当前 URL 比，
// 一换页就清掉旧 session；toggle 里再比一次只是监听没生效时的兜底。
let startedHref = '';

// 比较"是否还在同一个页面"时忽略 hash：点击页内锚点（docs 目录跳转）只改 hash、
// 正文没变，不应把已有译文清掉。代价是纯 hash 路由（#/path）的 SPA 检测不到换页，
// 这类站点如今很少，残留时再 toggle 一次即可清掉。
function pageKey(href: string): string {
  return href.split('#', 1)[0] ?? href;
}

// 每次 start / stop 都 ++。in-flight 翻译完成时 session 不匹配就丢弃，
// 避免 stop 后 stale 回调把译文塞回页面、或 toggle 重启时旧 session 干扰新 session。
let sessionId = 0;

// 全页只检测一次源语言；toggle 关再开也复用，避免重复 detect
let detectedLanguagePromise: Promise<string> | null = null;

// 简单并发队列
let inflight = 0;
const queue: Array<() => void> = [];

// 译文样式只 inject 一次
function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // 用 inherit 让译文跟原文的字号/字体一致，颜色用 currentColor 跟随主题
  style.textContent = `
    .${TRANSLATION_CLASS} {
      display: block;
      margin: 0.4em 0 0.6em 0;
      padding: 0.3em 0.6em;
      border-left: 3px solid rgba(127, 127, 127, 0.4);
      color: inherit;
      opacity: 0.92;
      font: inherit;
      white-space: pre-wrap;
      line-height: 1.55;
    }
    .${TRANSLATION_CLASS}[data-tnyl-pending] {
      opacity: 0.5;
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}

function enqueue(task: () => Promise<void>): void {
  const run = async () => {
    inflight++;
    try {
      await task();
    } finally {
      inflight--;
      const next = queue.shift();
      if (next) next();
    }
  };
  if (inflight < MAX_CONCURRENT) {
    run();
  } else {
    queue.push(run);
  }
}

async function getSourceLanguage(sampleText: string): Promise<string> {
  if (!detectedLanguagePromise) {
    detectedLanguagePromise = resolveSourceLanguage(sampleText).then((r) => r.language);
    // 检测失败不缓存被拒 promise，否则本页之后每段都复用同一个失败结果、永不恢复
    detectedLanguagePromise.catch(() => { detectedLanguagePromise = null; });
  }
  return detectedLanguagePromise;
}

// 默认把译文当兄弟节点插在原文 afterend。但当原文的父容器是 flex/grid 时，
// 兄弟节点会变成同一行的另一个 item，译文被挤到原文右边（例：ghostty 文档标题
// <div display:flex><h3>标题</h3><a>锚点复制按钮</a></div>，译文插在 h3 后就排到了右侧）。
// 这种情况改成把译文塞进原文元素内部当末尾子节点，靠原文自身的块级布局换行到下方。
function insertTranslationNode(el: Element, node: HTMLElement): void {
  // td/th 的 afterend 兄弟是非法 DOM（同一行内多出一个非 td/th 节点），浏览器会把它
  // 渲染到怪位置；直接塞进单元格内部当末尾子节点。
  if (el.tagName === 'TD' || el.tagName === 'TH') {
    el.appendChild(node);
    return;
  }
  const parent = el.parentElement;
  const display = parent ? getComputedStyle(parent).display : '';
  if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') {
    el.appendChild(node);
  } else {
    el.insertAdjacentElement('afterend', node);
  }
}

async function translateParagraph(el: Element): Promise<void> {
  if (el.hasAttribute(MARKER_ATTR)) return;
  const mySession = sessionId;
  el.setAttribute(MARKER_ATTR, '');

  const text = paragraphText(el).trim();
  if (!text) return;

  // 译文节点先以 pending 态插入，避免布局突变；翻译完直接替换文本
  const node = document.createElement('div');
  node.className = TRANSLATION_CLASS;
  node.setAttribute('data-tnyl-pending', '');
  node.textContent = '翻译中…';
  insertTranslationNode(el, node);

  try {
    const lang = await getSourceLanguage(text);
    if (mySession !== sessionId) { node.remove(); return; }
    const result = await translate(text, lang);
    if (mySession !== sessionId) { node.remove(); return; }
    node.removeAttribute('data-tnyl-pending');
    node.textContent = result;
  } catch (err) {
    if (mySession !== sessionId) { node.remove(); return; }
    const msg = err instanceof Error ? err.message : '翻译失败';
    console.warn('[叫你翻译你聋吗] 段落翻译失败:', msg);
    node.removeAttribute('data-tnyl-pending');
    node.textContent = `[翻译失败] ${msg}`;
    node.style.color = 'rgba(192, 57, 43, 0.85)';
  }
}

let observer: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        observer!.unobserve(el);
        enqueue(() => translateParagraph(el));
      }
    },
    // 提前 300px 开始翻译，让用户滚到时译文多半已经在了
    { rootMargin: '300px 0px' },
  );
  return observer;
}

function startPageTranslation(): void {
  started = true;
  sessionId++;
  injectStyle();

  const root = findContentRoot();
  const paragraphs = collectParagraphs(root).filter((el) => !el.hasAttribute(MARKER_ATTR));
  if (paragraphs.length === 0) {
    console.warn('[叫你翻译你聋吗] 未识别到正文段落');
    return;
  }
  // 把 root 信息打到 console，方便用户在识别异常时反查（"为什么这页 metadata 被翻了"）
  console.log(
    `[叫你翻译你聋吗] 整页翻译启动，root: <${root.tagName.toLowerCase()}${root.id ? '#' + root.id : ''}${root.className ? '.' + root.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''}>，候选段落: ${paragraphs.length}`,
  );

  const obs = getObserver();
  for (const p of paragraphs) obs.observe(p);
}

function stopPageTranslation(): void {
  started = false;
  sessionId++; // in-flight 翻译完成时 session 不匹配 → 丢弃，不会再 mutate DOM
  observer?.disconnect();
  observer = null;
  queue.length = 0;
  // inflight 不重置：旧 task 完成后自己会 -- 减回去；强制清零反而可能让新 task 超并发
  for (const node of document.querySelectorAll(`.${TRANSLATION_CLASS}`)) {
    node.remove();
  }
  for (const el of document.querySelectorAll(`[${MARKER_ATTR}]`)) {
    el.removeAttribute(MARKER_ATTR);
  }
  console.log('[叫你翻译你聋吗] 整页翻译已取消');
}

// SPA 站内跳转不重载 content script，上个页面的译文节点会残留、叠在新页面上
// （用户反馈的"翻到下一页，上一页的译文还在"）。Navigation API 的
// currententrychange 覆盖 pushState / replaceState / 前进后退，一换页就清场。
// Chrome 102+ 才有 navigation 对象；本扩展要求 138+，判空只为非浏览器环境。
if (typeof navigation !== 'undefined') {
  navigation.addEventListener('currententrychange', () => {
    if (started && pageKey(location.href) !== pageKey(startedHref)) {
      stopPageTranslation();
    }
  });
}

/** 右键菜单触发：未启动则开始，已启动则取消并清除译文。 */
export function togglePageTranslation(): void {
  // 兜底：currententrychange 没生效时（未知的路由方式），URL 已变就先清掉
  // 旧 session，当作未启动重新开始。否则新页面第一次右键只是 stop 掉残留状态、
  // 看不到任何译文，要点第二次才真正翻译。
  if (started && pageKey(location.href) !== pageKey(startedHref)) {
    stopPageTranslation();
  }

  if (started) {
    stopPageTranslation();
  } else {
    startedHref = location.href;
    startPageTranslation();
  }
}
