// 划词翻译扩展入口：监听选区 → 延迟 150ms 显示触发器 → 用户点击 → 翻译 → 气泡显示。
// 也接收 background 转发的右键菜单消息（翻译整页 / 翻译选中文本）。

import { type Anchor, hide, isEventInsideBubble, show } from './bubble';
import { togglePageTranslation } from './page-translator';
import { resolveSourceLanguage, translate } from '../translate/translate';

const MIN_TEXT_LENGTH = 2;
const SHOW_TRIGGER_DELAY_MS = 150;
const SHOW_SPINNER_DELAY_MS = 200;

// 每次新选区 / 新点击翻译 都会 ++currentSessionId。
// 异步过程（检测、翻译、下载进度）开始时记下自己的 session，
// 完成回调里如果 session !== currentSessionId 说明已经被新动作取代，丢弃结果。
let currentSessionId = 0;

// mouseup → 防抖延迟 150ms 才显示触发器，避免快速选/取消造成闪烁
let pendingShowTimer: ReturnType<typeof setTimeout> | null = null;

// 记录最近一次右键点击的位置，供"翻译选中文本"菜单项做气泡锚点
// （contextmenu 事件必然早于 background 转发的消息，届时这里总有值）
let lastContextMenuPos: Anchor | null = null;

interface SelectionInfo {
  text: string;
  rect: DOMRect;
}

function getCurrentSelection(): SelectionInfo | null {
  // 表单字段（input / textarea）单独处理：window.getSelection() 里没它的内容
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start == null || end == null || start === end) return null;
    const text = active.value.slice(start, end).trim();
    if (!text) return null;
    // 不精确到光标位置；定位到输入框右下角即可。
    // 精确到光标需要 mirror-div 技巧，post-MVP 再考虑。
    const r = active.getBoundingClientRect();
    return { text, rect: new DOMRect(r.right - 1, r.bottom - 1, 1, 1) };
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
}

function clearPendingShow(): void {
  if (pendingShowTimer !== null) {
    clearTimeout(pendingShowTimer);
    pendingShowTimer = null;
  }
}

function scheduleShowTrigger(mouseAnchor: Anchor | null): void {
  clearPendingShow();
  pendingShowTimer = setTimeout(() => {
    pendingShowTimer = null;
    handleSelection(mouseAnchor);
  }, SHOW_TRIGGER_DELAY_MS);
}

function handleSelection(mouseAnchor: Anchor | null): void {
  const sel = getCurrentSelection();
  if (!sel) return;

  const text = sel.text;
  if (text.length < MIN_TEXT_LENGTH) return;

  const session = ++currentSessionId;
  // 优先用鼠标释放点；键盘选择（没有鼠标位置）退回选区右下角
  const anchor: Anchor = mouseAnchor ?? {
    x: sel.rect.right,
    y: sel.rect.bottom,
  };

  show({
    kind: 'trigger',
    onClick: () => void runTranslation(text, anchor, session),
  }, anchor);
}

async function runTranslation(text: string, anchor: Anchor, session: number): Promise<void> {
  if (session !== currentSessionId) return;
  console.log('[叫你翻译你聋吗] 正在翻译:', text.slice(0, 80));

  // 翻译超过 200ms 才把触发器换成 spinner。
  // 短翻译（缓存命中、几百字以内）通常 <200ms，根本看不到 spinner，避免闪烁。
  const spinnerTimer = setTimeout(() => {
    if (session === currentSessionId) show({ kind: 'translating' }, anchor);
  }, SHOW_SPINNER_DELAY_MS);

  try {
    const detected = await resolveSourceLanguage(text);
    if (session !== currentSessionId) return;

    const result = await translate(text, detected.language);
    if (session !== currentSessionId) return;

    show({ kind: 'translated', text: result, uncertain: detected.uncertain }, anchor);
  } catch (err) {
    if (session !== currentSessionId) return;
    const message = err instanceof Error ? err.message : '翻译失败';
    show({ kind: 'error', message }, anchor);
  } finally {
    // 不管成功失败、不管 spinner 是否已经显示，都把定时器清掉，
    // 防止结果显示后 spinner 又把它盖掉
    clearTimeout(spinnerTimer);
  }
}

document.addEventListener('contextmenu', (event) => {
  lastContextMenuPos = { x: event.clientX, y: event.clientY };
});

document.addEventListener('mouseup', (event) => {
  if (isEventInsideBubble(event)) return; // 用户在气泡内部交互，不重新触发
  scheduleShowTrigger({ x: event.clientX, y: event.clientY });
});

// 键盘选择：按住 Shift 配合方向键 / Home / End 改变选区，没有鼠标位置可用。
// 只看 shiftKey——纯方向键是移动光标、不产生选区，触发也只是白排一个定时器。
document.addEventListener('keyup', (event) => {
  if (event.shiftKey) {
    scheduleShowTrigger(null);
  }
});

// 点击气泡外部 → 取消未触发的延时 + 关闭已显示的气泡
document.addEventListener(
  'mousedown',
  (event) => {
    if (!isEventInsideBubble(event)) {
      clearPendingShow();
      hide();
    }
  },
  true,
);

// 滚动 → 关闭气泡（系统词典弹窗也是这种行为）。
// capture:true 让内部可滚动容器的 scroll 也能收到（scroll 不冒泡，但捕获阶段会经过 window）；
// 气泡自身滚长译文时 target 在气泡内，composedPath 命中 host 就跳过，否则会把气泡自己滚没。
window.addEventListener('scroll', (event) => {
  if (isEventInsideBubble(event)) return;
  clearPendingShow();
  hide();
}, { passive: true, capture: true });

// 右键菜单消息由 background service worker 转发
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'tnyl:translate-page') {
    // 再次触发即取消
    togglePageTranslation();
  } else if (message?.type === 'tnyl:translate-selection') {
    // 选区可能已丢失（比如右键菜单本身会短暂改变焦点）：退回用菜单自带的
    // selectionText 兜底，但它会丢换行，仅此一种情况下使用
    const text = (getCurrentSelection()?.text ?? message.text ?? '').trim();
    if (!text) return;
    void runTranslation(text, lastContextMenuPos ?? { x: 0, y: 0 }, ++currentSessionId);
  }
});
