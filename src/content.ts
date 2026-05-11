// 划词翻译扩展入口：监听选区 → 延迟 150ms 显示触发器 → 用户点击 → 翻译 → 气泡显示。
// 整个扩展只有这一个 content script，没有 service worker、没有消息传递。

import { type Anchor, hide, isEventInsideBubble, show } from './bubble';
import { detectLanguage, isApiAvailable, translate } from './translator';

const MIN_TEXT_LENGTH = 2;
const SHOW_TRIGGER_DELAY_MS = 150;
const SHOW_SPINNER_DELAY_MS = 200;

if (!isApiAvailable()) {
  console.warn(
    '[叫你翻译你聋吗] Chrome Translator API 不可用。需要 Chrome 138+ 的桌面版。',
  );
}

// 每次新选区 / 新点击翻译 都会 ++currentSessionId。
// 异步过程（检测、翻译、下载进度）开始时记下自己的 session，
// 完成回调里如果 session !== currentSessionId 说明已经被新动作取代，丢弃结果。
let currentSessionId = 0;

// mouseup → 防抖延迟 150ms 才显示触发器，避免快速选/取消造成闪烁
let pendingShowTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMouseAnchor: Anchor | null = null;

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
  pendingMouseAnchor = mouseAnchor;
  pendingShowTimer = setTimeout(() => {
    pendingShowTimer = null;
    handleSelection();
  }, SHOW_TRIGGER_DELAY_MS);
}

function handleSelection(): void {
  const sel = getCurrentSelection();
  if (!sel) return;

  const text = sel.text;
  if (text.length < MIN_TEXT_LENGTH) return;

  const session = ++currentSessionId;
  // 优先用鼠标释放点；键盘选择（没有鼠标位置）退回选区右下角
  const anchor: Anchor = pendingMouseAnchor ?? {
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
    const detected = await detectLanguage(text);
    if (session !== currentSessionId) return;

    const result = await translate(text, detected.language, (progress) => {
      if (progress >= 1) return; // 模型已缓存时 Chrome 仍会触发 progress=1，过滤
      console.log(`[叫你翻译你聋吗] 下载翻译模型: ${Math.round(progress * 100)}%`);
    });
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

document.addEventListener('mouseup', (event) => {
  if (isEventInsideBubble(event)) return; // 用户在气泡内部交互，不重新触发
  scheduleShowTrigger({ x: event.clientX, y: event.clientY });
});

// 键盘选择（shift + 方向键），没有鼠标位置可用
document.addEventListener('keyup', (event) => {
  if (event.shiftKey || event.key.startsWith('Arrow')) {
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

// 滚动 → 关闭气泡（系统词典弹窗也是这种行为）
window.addEventListener('scroll', () => {
  clearPendingShow();
  hide();
}, { passive: true });
