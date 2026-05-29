// Service worker：注册右键菜单"翻译整页" + 代为发 LLM 后端的 fetch（绕开 content script CORS）。
// Translator API 不能在 worker 上下文调用，所以 Chrome 内置翻译还是在 content script 做。

const MENU_ID = 'tnyl-translate-page';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '翻译整页（沉浸式）',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'tnyl:translate-page' }).catch((err) => {
    // 用户在 chrome://、商店、PDF 等 content script 注入不到的页面右键时
    // sendMessage 会 reject —— 静默忽略，划词翻译那边的限制一样
    console.warn('[叫你翻译你聋吗] 当前页面无法翻译:', err);
  });
});

// LLM 后端 fetch 代理：content script 调 chrome.runtime.sendMessage 到这里，
// background 跨域 fetch（manifest host_permissions <all_urls> 允许），返回 JSON。
// MV3 service worker 异步响应必须 return true 保持 sendResponse 通道开放。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'tnyl:llm-fetch') return;
  (async () => {
    try {
      const resp = await fetch(message.url, {
        method: 'POST',
        headers: message.headers,
        body: message.body,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        sendResponse({ ok: false, status: resp.status, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` });
        return;
      }
      const data = await resp.json();
      sendResponse({ ok: true, status: resp.status, data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[叫你翻译你聋吗] LLM fetch 失败:', err);
      sendResponse({ ok: false, error: msg });
    }
  })();
  return true; // 异步 sendResponse
});
