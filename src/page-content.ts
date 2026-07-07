// 整页沉浸式翻译的核心正文识别算法：findContentRoot 圈出正文容器，
// collectParagraphs 在容器内挑出候选段落。纯 DOM 启发式，不依赖翻译状态；
// 算法完整论证见 docs/decisions.md。

const MIN_TEXT_LENGTH = 4;

// root 收敛：子树要保留多少比例的正文字符才算"足够代表整体"。
// 0.8 沿用旧版 80% 阈值的直觉——正文容器该占绝对多数。
const ROOT_KEEP_RATIO = 0.8;
// root 收敛：即使比例达标，绝对丢弃字符数超过此值也不收窄。
// 防止"总量很大时 80% 阈值放过大段正文"（如 StackOverflow 问题区 1500+ 字符）。
const ROOT_MAX_DROPPED_CHARS = 500;
// 叶子块候选（div/td）文本长度下限：比段落标签门槛更严，过滤 UI 碎屑（按钮态文字等）。
const LEAF_MIN_CHARS = 25;
// 叶子块候选文本长度上限：超长说明很可能吞并了多个逻辑段落或整块无结构 blob。
const LEAF_MAX_CHARS = 2000;

// 祖先 class/id 负面 token（借鉴 Readability getClassWeight 的负权重，token 边界匹配避免
// "abandoned" 命中 "ads" 之类子串误伤）。刻意不含 comment/header/menu/nav——论坛评论是要翻的
// 正文，article-header 里常有标题，误伤面太大。
const UNLIKELY_CLASS_RE = /(^|[-_ ])(sidebar|footer|breadcrumbs?|banner|advert(isement)?|ads?|sponsor|promo|share|social|cookie|consent|gdpr|subscribe|newsletter|related|recommend(ed|ations?)?|popup|modal|toolbar|pagination|pager|masthead|disqus)([-_ ]|$)/i;

// 叶子块候选判定用：视为"块级"的标签集合，出现即说明该 div/td 不是叶子。
const BLOCK_SELECTOR = 'address,article,aside,blockquote,dd,details,dialog,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,menu,nav,ol,p,pre,section,table,td,th,ul';

// 排除：自身或祖先在这些标签内的"段落"不翻译
// TABLE/FORM 不在此列——分别按"数据表"/"真表单"细粒度判断，见 isExcluded。
// a：整卡包链接的推荐位标题（BBC/GitHub 的泄漏源）与其祖先都不翻译；
//    单链接标题豁免（isMostlyLinks 里处理）说的是 a 在标题内部，这里管的是标题在 a 内部，互不冲突。
// SUMMARY：<details> 的折叠触发标签本质是控件标注（类似 button），不是正文；
//    新增的 div/td 叶子块候选会把 MDN 兼容性徽章（<summary><div>Baseline...</div></summary>）
//    误当成候选，这里跟 BUTTON 同等对待整体排除，<details> 展开后的正文本身不受影响。
const EXCLUDE_TAGS = new Set([
  'PRE', 'CODE', 'SCRIPT', 'STYLE', 'NOSCRIPT',
  'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'MENU',
  'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'SUMMARY',
]);

const REAL_FORM_CONTROL_SELECTOR = 'input:not([type=hidden]),select,textarea,button';

const EXCLUDE_SELECTOR = [...EXCLUDE_TAGS].join(',').toLowerCase() + ',a';

// 候选段落标签
const PARAGRAPH_TAGS = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'dd', 'dt', 'figcaption'];
const PARAGRAPH_SELECTOR = PARAGRAPH_TAGS.join(',');
const LEAF_CANDIDATE_SELECTOR = `${PARAGRAPH_SELECTOR},div,td`;

// paragraphText 跳过的后代标签。两类：
// - style/script/noscript/template：DOM 里有 textContent 但浏览器不渲染（Wikipedia
//   引用 li 内嵌 TemplateStyles `<style>`，裸 textContent 会把 CSS 当引文带出来）；
// - button/select/textarea：控件标注不是正文。EXCLUDE_TAGS 只管"候选在控件里面"
//   （closest 查祖先），管不了"候选包含控件"——Agora 文档的代码 tab 栏
//   `<div role=tablist><button>Python SDK</button>…</div>` 全部文字都来自 button，
//   照样过叶子块门槛。跳过控件文字后该 div 有效文本为空，被 hasMeaningfulText 挡掉；
//   正文段落里混着的复制按钮之类的标注文字也不再被送去翻译。
const SKIPPED_DESCENDANT_SELECTOR = 'style,script,noscript,template,button,select,textarea';
const SKIPPED_DESCENDANT_TAGS = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'SELECT', 'TEXTAREA']);

/**
 * 元素可见文本：跳过 SKIPPED_DESCENDANT_TAGS 后代的 textContent（不渲染的文本
 * 与控件标注，理由见上方常量注释）。
 */
export function paragraphText(el: Element): string {
  if (!el.querySelector(SKIPPED_DESCENDANT_SELECTOR)) return el.textContent ?? '';
  let out = '';
  const walk = (node: Element) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { // Node.TEXT_NODE
        out += (child as unknown as CharacterData).data ?? '';
      } else if (child.nodeType === 1) { // Node.ELEMENT_NODE
        const childEl = child as Element;
        if (SKIPPED_DESCENDANT_TAGS.has(childEl.tagName)) continue;
        walk(childEl);
      }
    }
  };
  walk(el);
  return out;
}

const dataTableCache = new WeakMap<Element, boolean>();

/**
 * 数据表判定：有 caption/thead/th，或任一行 td 数 >= 4，或 role 声明为 grid/table。
 * 命中即视为数据表，整体排除（代码标识符和表头混排，整段翻译容易吞进代码）。
 * 不命中则是布局表（HN 的嵌套 table 布局、老式排版），放行内部候选。
 */
function isDataTable(t: Element): boolean {
  const cached = dataTableCache.get(t);
  if (cached !== undefined) return cached;
  let result = false;
  const role = t.getAttribute('role');
  if (t.querySelector('caption,thead,th') || role === 'grid' || role === 'table') {
    result = true;
  } else {
    for (const row of Array.from(t.querySelectorAll('tr'))) {
      if (row.querySelectorAll('td').length >= 4) { result = true; break; }
    }
  }
  dataTableCache.set(t, result);
  return result;
}

const realFormCache = new WeakMap<Element, boolean>();

/**
 * 真表单判定：含 input（非 hidden）/select/textarea/button 等可见控件才算真表单，整体排除。
 * old.reddit.com 把每条评论正文包在 `<form class="usertext">` 里（内联编辑用的容器，
 * 服务端渲染的 HTML 里只有一个 hidden input），一刀切排除 FORM 会把全站评论都吞掉；
 * 这种只有 hidden input、无可见控件的 form 视为普通容器放行。
 */
function isRealForm(f: Element): boolean {
  const cached = realFormCache.get(f);
  if (cached !== undefined) return cached;
  const result = f.querySelector(REAL_FORM_CONTROL_SELECTOR) !== null;
  realFormCache.set(f, result);
  return result;
}

export function findContentRoot(): Element {
  const seed = document.querySelector('main')
    ?? document.querySelector('article')
    ?? document.body;

  // web app 页（HuggingFace / GitHub）的 <main> 常同时含正文和侧栏，
  // 而侧栏里可能有零星 <p>（例如 GitHub About 描述）——简单的"最小公共祖先"
  // 会被那一个 <p> 拉宽到整个 main。
  //
  // 改成按字符量加权：每个有效 <p> 记 paragraphText 后的字符数为权重，
  // 找最深的子树，其内字符和 >= 全部字符的 80%，且丢弃的字符绝对值 <= 500。
  // 单纯按"个数"算比例对"多个短侧栏 p / 一个长正文 p"这种场景不敏感
  // （GitHub 侧栏零星短 p 加起来才两三百字符，允许收窄进 README article；
  //  StackOverflow 问题区虽然 p 个数占少数，但字符量有 1500+，不该被当作噪声丢弃，
  //  root 因此停在包含问题+答案的祖先，而不会收窄到 #answers）。
  const validPs = Array.from(seed.querySelectorAll('p')).filter((p) => !isExcluded(p));
  if (validPs.length < 3) return seed;

  const weights = new Map<Element, number>();
  let totalChars = 0;
  for (const p of validPs) {
    const chars = paragraphText(p).trim().length;
    weights.set(p, chars);
    totalChars += chars;
  }

  let best: Element = seed;
  let bestDepth = -1;

  const walk = (el: Element, depth: number): number => {
    let chars = weights.get(el) ?? 0;
    for (const child of Array.from(el.children)) {
      chars += walk(child, depth + 1);
    }
    const dropped = totalChars - chars;
    if (chars >= totalChars * ROOT_KEEP_RATIO && dropped <= ROOT_MAX_DROPPED_CHARS && depth > bestDepth) {
      best = el;
      bestDepth = depth;
    }
    return chars;
  };
  walk(seed, 0);

  return best;
}

function isExcluded(el: Element): boolean {
  if (el.closest(EXCLUDE_SELECTOR) !== null) return true;
  const table = el.closest('table');
  if (table !== null && isDataTable(table)) return true;
  const form = el.closest('form');
  if (form !== null && isRealForm(form)) return true;
  return false;
}

function hasMeaningfulText(el: Element): boolean {
  const text = paragraphText(el).trim();
  if (text.length < MIN_TEXT_LENGTH) return false;
  // 全是数字/标点的不翻译（页码、序号）
  if (!/\p{L}/u.test(text)) return false;
  return true;
}

/**
 * 从 el（含自身）向上走到 root（不含 root），任一元素的 class/id 命中
 * UNLIKELY_CLASS_RE 就判定为"可能是无关区块"（侧边栏/广告/推荐位等）。
 */
function hasUnlikelyAncestor(el: Element, root: Element): boolean {
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const token = `${cur.className ?? ''} ${cur.id ?? ''}`;
    if (UNLIKELY_CLASS_RE.test(token)) return true;
    cur = cur.parentElement;
  }
  return false;
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * 候选元素的文字大部分来自 <a> 子节点 → 多半是 metadata 行（用户名 + 时间戳链接、
 * "Replies: 5 comments" 之类）。正常正文段落里 inline link 不会占 70%。
 * 例：GitHub Discussion 的 `<h3><a>spenserblack</a> <a>May 21, 2025</a></h3>`
 *      整行近 100% 是 link 文字。
 * 文档站常把标题整体包进自链接锚点（如 MDN 的 `<h2><a href="#…">Heading</a></h2>`），
 * 也会被 >70% 链接占比误杀；这种单链接标题豁免，多链接（用户名+时间戳）仍跳过。
 */
function isMostlyLinks(el: Element): boolean {
  const total = paragraphText(el).replace(/\s+/g, '').length;
  if (total === 0) return false;
  const links = el.querySelectorAll('a');
  let linkLen = 0;
  for (const a of links) {
    linkLen += (a.textContent ?? '').replace(/\s+/g, '').length;
  }
  if (linkLen / total <= 0.7) return false;
  // 单链接标题是「自链接标题」而非 metadata，豁免；多链接（用户名+时间戳）仍跳过
  if (HEADING_TAGS.has(el.tagName) && links.length === 1) return false;
  return true;
}

/**
 * el 是否满足候选条件本身（不含"让位给更内层"的检查——那是第二遍的事）。
 * div/td 走更严的叶子块门槛；p/li/heading 等走普通门槛。
 */
function qualifies(el: Element): boolean {
  if (isExcluded(el)) return false;
  const isLeafBlockTag = el.tagName === 'DIV' || el.tagName === 'TD';
  if (isLeafBlockTag) {
    // div/td 叶子块候选：门槛比段落标签更严——必须不含任何块级后代，
    // 且文本长度落在 [LEAF_MIN_CHARS, LEAF_MAX_CHARS] 区间，避免 UI 碎屑和超长 blob；
    // 且不能带 hidden 属性——这是真正的"不渲染"标记（Vite 文档页给爬虫用的 LLM 提示文本、
    // GitHub 菜单里预先隐藏待 JS 切换的项），而不是 Tailwind 的 `class="hidden lg:flex"`
    // 响应式断点类名（那个在 class 属性里，不会命中 hasAttribute('hidden')）。
    if (el.hasAttribute('hidden')) return false;
    if (el.querySelector(BLOCK_SELECTOR) !== null) return false;
    const len = paragraphText(el).trim().length;
    if (len < LEAF_MIN_CHARS || len > LEAF_MAX_CHARS) return false;
  }
  if (!hasMeaningfulText(el)) return false;
  if (isMostlyLinks(el)) return false;
  return true;
}

export function collectParagraphs(root: Element): Element[] {
  const nodes = Array.from(root.querySelectorAll(LEAF_CANDIDATE_SELECTOR));
  // 先筛掉祖先命中排除规则的（isExcluded 各类 / 负面 class 祖先），
  // 且不含"让位给更内层"的检查——需要先知道全体合格候选，才能判断"是否含有更内层的合格候选"。
  const eligible = nodes.filter((el) => !hasUnlikelyAncestor(el, root) && qualifies(el));
  const eligibleSet = new Set(eligible);

  // 已有嵌套的合格候选时只取最内层：<li> 含 <p> 时翻译 <p> 不翻译 <li>；
  // 含 div/td 叶子块时也让位给更内层。用"是否真的合格"而非"是否匹配选择器"判断，
  // 避免装饰性空 div（如自链接标题里的复制锚点按钮 wrapper）误伤外层候选。
  // 对每个候选从其 parentElement 向上走到 root（不含 root），凡途中经过的合格候选
  // 都记为"含更内层合格后代"——other 是 el 的后代等价于从 other 向上会经过 el，
  // 这样一趟遍历就能替代逐对 el.contains(other) 的双重扫描。
  const hasQualifyingDescendant = new Set<Element>();
  for (const el of eligible) {
    let cur = el.parentElement;
    while (cur && cur !== root) {
      if (eligibleSet.has(cur)) hasQualifyingDescendant.add(cur);
      cur = cur.parentElement;
    }
  }
  return eligible.filter((el) => !hasQualifyingDescendant.has(el));
}
