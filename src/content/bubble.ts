// 翻译气泡 UI。
// 用 Shadow DOM（mode: 'closed'）完全隔离页面 CSS，防止页面样式污染气泡，
// 也防止气泡样式影响页面。
// 主题（亮/暗）跟随系统：用 prefers-color-scheme 媒体查询切换 CSS 变量。

// 触发器图标内联进 JS：免得动 web_accessible_resources，content script
// 在任意页面都能直接用
import triggerIconUrl from './trigger-icon.png?inline';

export type BubbleState =
  | { kind: 'trigger'; onClick: () => void }
  | { kind: 'translating' }
  | { kind: 'translated'; text: string; uncertain: boolean }
  | { kind: 'error'; message: string };

/** 屏幕坐标（viewport-relative）。气泡会显示在它的右下方（边缘不够则翻转）。 */
export interface Anchor {
  x: number;
  y: number;
}

const HOST_ID = 'tnyl-bubble-host';
const BUBBLE_MAX_WIDTH = 360;
const BUBBLE_EST_HEIGHT = 80; // 用于翻转判断的高度估值，实际渲染后会再修正
const GAP_PX = 12;
const VIEWPORT_PADDING = 8;

let hostEl: HTMLDivElement | null = null;
let bubbleEl: HTMLDivElement | null = null;
// 最近一次 show() 传入的 state，用于让 click 监听器知道当前是否处于 trigger 态
let currentState: BubbleState | null = null;

function ensure(): { host: HTMLDivElement; bubble: HTMLDivElement } {
  // 某些站点（Gmail / Notion）会重写 DOM，host 可能被删掉，懒重建
  if (hostEl && bubbleEl && document.documentElement.contains(hostEl)) {
    return { host: hostEl, bubble: bubbleEl };
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  // 用 all: initial 让页面 CSS 不影响 host 自身的盒模型
  host.style.all = 'initial';
  // 这些 4 个属性 all: initial 也会重置，需要在之后再设
  host.style.position = 'absolute';
  host.style.top = '0';
  host.style.left = '0';
  host.style.zIndex = '2147483647'; // 32-bit 最大整数，胜过几乎所有页面 z-index
  host.style.pointerEvents = 'none'; // 气泡本体上再开 auto
  host.style.visibility = 'hidden';

  // 用 documentElement 而不是 body：document_start 时 body 可能还不存在
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host {
      --bg: #ffffff;
      --color: #1a1a1a;
      --hint: #666666;
      --border: 1px solid rgba(0, 0, 0, 0.12);
      --shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      --error: #c0392b;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1f1f1f;
        --color: #f5f5f5;
        --hint: #aaaaaa;
        --border: 1px solid rgba(255, 255, 255, 0.1);
        --shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
        --error: #ff8080;
      }
    }

    .bubble {
      pointer-events: auto;
      box-sizing: border-box;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    /* trigger 直接用图标，不要外框；图标本身就是完整的贴纸设计 */
    .bubble.trigger,
    .bubble.translating {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      user-select: none;
    }
    .bubble.trigger {
      cursor: pointer;
      transition: transform 0.12s ease-out;
    }
    .bubble.trigger:hover {
      transform: scale(1.12);
    }
    .bubble.trigger img {
      width: 100%;
      height: 100%;
      display: block;
      pointer-events: none;
      -webkit-user-drag: none;
    }
    /* translating 套一个轻量底色让 spinner 看得清 */
    .bubble.translating {
      background: var(--bg);
      border: var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    /* translated / error 才用气泡式样的卡片 —— 朴素白/暗底、留白足、行距宽（设计稿 ②）。
       卡片本身 overflow: visible，让尾巴（::before）能探出边缘不被裁；长译文的滚动放到内层 .scroll。 */
    .bubble.info {
      position: relative;
      background: var(--bg);
      color: var(--color);
      border: var(--border);
      border-radius: 14px;
      box-shadow: var(--shadow);
      min-width: 180px;
      max-width: ${BUBBLE_MAX_WIDTH}px;
      padding: 13px 16px;
      word-break: break-word;
      user-select: text;
    }
    .bubble.info .scroll {
      max-height: 56vh;
      overflow-y: auto;
      /* 滚到顶/底不要把滚动传给页面，否则会触发 window scroll 把气泡关掉 */
      overscroll-behavior: contain;
    }
    /* 指向选区的小尾巴：旋转 45° 的方块只露朝外两条边的描边，贴在靠近 anchor 的那条边。
       方向类（tail-top/bottom + tail-left/right）由 positionHost 按翻转情况加。 */
    .bubble.info.tail-top::before,
    .bubble.info.tail-bottom::before {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      background: var(--bg);
      transform: rotate(45deg);
    }
    .bubble.info.tail-top::before { top: -7px; border-left: var(--border); border-top: var(--border); }
    .bubble.info.tail-bottom::before { bottom: -7px; border-right: var(--border); border-bottom: var(--border); }
    .bubble.info.tail-left::before { left: 22px; }
    .bubble.info.tail-right::before { right: 22px; }
    .spinner {
      width: 14px;
      height: 14px;
      box-sizing: border-box;
      border: 2px solid rgba(127, 127, 127, 0.3);
      border-top-color: var(--color);
      border-radius: 50%;
      animation: tnyl-spin 0.8s linear infinite;
    }
    @keyframes tnyl-spin {
      to { transform: rotate(360deg); }
    }
    .translation {
      /* 保留译文里的换行，让多段输入分段显示；行距放宽，贴合设计稿"行距宽"。 */
      white-space: pre-wrap;
      line-height: 1.7;
    }
    .hint {
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--hint);
    }
    .error { color: var(--error); }
  `;
  shadow.appendChild(style);

  const bubble = document.createElement('div');
  bubble.className = 'bubble info';
  bubble.dir = 'auto';
  // 单一 click 监听器：只在 trigger 态时回调 onClick
  bubble.addEventListener('click', () => {
    if (currentState?.kind === 'trigger') {
      currentState.onClick();
    }
  });
  shadow.appendChild(bubble);

  hostEl = host;
  bubbleEl = bubble;
  return { host, bubble };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderState(bubble: HTMLDivElement, state: BubbleState): void {
  // trigger / translating 是紧凑的方块（28x28）；translated / error 是宽气泡
  const cls = state.kind === 'trigger' ? 'trigger'
    : state.kind === 'translating' ? 'translating'
      : 'info';
  bubble.className = `bubble ${cls}`;

  switch (state.kind) {
    case 'trigger':
      bubble.innerHTML = `<img src="${triggerIconUrl}" alt="翻译选中文本" />`;
      bubble.setAttribute('role', 'button');
      bubble.setAttribute('aria-label', '翻译选中文本');
      return;
    case 'translating':
      bubble.removeAttribute('role');
      bubble.setAttribute('aria-label', '翻译中');
      bubble.innerHTML = '<div class="spinner"></div>';
      return;
    case 'translated': {
      const safeText = escapeHtml(state.text);
      const hint = state.uncertain
        ? '<div class="hint">（源语言不确定，按英语翻译）</div>'
        : '';
      bubble.removeAttribute('role');
      bubble.removeAttribute('aria-label');
      bubble.innerHTML = `<div class="scroll"><div class="translation">${safeText}</div>${hint}</div>`;
      return;
    }
    case 'error':
      bubble.removeAttribute('role');
      bubble.removeAttribute('aria-label');
      bubble.innerHTML = `<div class="scroll"><div class="error">${escapeHtml(state.message)}</div></div>`;
      return;
  }
}

function positionHost(host: HTMLDivElement, anchor: Anchor): void {
  // anchor 是 viewport-relative；host 是 absolute（相对页面顶部）。
  // 用实际渲染宽高定位——好处是 trigger（32px）紧贴鼠标，
  // 展开成气泡（180-360px）时 anchor 端边对齐（右边不够就向左延展），
  // 因此用户视觉上感觉是"从触发器位置原地长出气泡"，而不是大幅跳动。
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const hostRect = host.getBoundingClientRect();
  const actualWidth = hostRect.width || 32;
  const actualHeight = hostRect.height || BUBBLE_EST_HEIGHT;

  let flipX = false;
  let flipY = false;

  // 水平：默认放在指针右侧；右边放不下 → 翻到指针左侧（左对齐 anchor 的右边缘）
  let left = anchor.x + GAP_PX;
  const rightLimit = window.innerWidth - VIEWPORT_PADDING;
  if (left + actualWidth > rightLimit) {
    left = anchor.x - actualWidth - GAP_PX;
    flipX = true;
  }
  // 极端情况（视口极窄）：靠右紧贴边缘
  if (left < VIEWPORT_PADDING) {
    left = rightLimit - actualWidth;
  }

  // 垂直：默认放在指针下方；下方放不下 → 翻到上方
  let top = anchor.y + GAP_PX;
  if (top + actualHeight + VIEWPORT_PADDING > window.innerHeight) {
    top = anchor.y - actualHeight - GAP_PX;
    flipY = true;
  }
  if (top < VIEWPORT_PADDING) top = VIEWPORT_PADDING;

  host.style.left = `${left + scrollX}px`;
  host.style.top = `${top + scrollY}px`;

  // 尾巴指向选区：anchor 在气泡哪一侧，尾巴就贴哪条边。
  // 默认（未翻转）气泡在 anchor 右下 → anchor 在左上 → 尾巴在顶边左侧；翻转时对应切换。
  // 只有译文/错误气泡（.info）有尾巴；trigger/translating 是小图标，不加。
  if (bubbleEl?.classList.contains('info')) {
    bubbleEl.classList.add(flipY ? 'tail-bottom' : 'tail-top', flipX ? 'tail-right' : 'tail-left');
  }
}

export function show(state: BubbleState, anchor: Anchor): void {
  currentState = state;
  const { host, bubble } = ensure();
  renderState(bubble, state);
  host.style.visibility = 'visible';
  // 渲染后再定位，便于读取真实高度
  positionHost(host, anchor);
}

export function hide(): void {
  currentState = null;
  if (hostEl) hostEl.style.visibility = 'hidden';
}

/** 事件是否发生在气泡内部（用于"点击外部关闭"判断） */
export function isEventInsideBubble(event: Event): boolean {
  if (!hostEl) return false;
  // closed shadow root 不会暴露内部节点，但 host 一定在 composedPath 里
  return event.composedPath().includes(hostEl);
}
