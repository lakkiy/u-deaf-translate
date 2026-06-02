// 浏览器图标弹窗：显示当前后端、改目标语言、一键翻整页、开设置。
// 极简——不显示 token/延迟/成本统计，也没有快捷键提示（按用户要求砍掉）。
// 「翻这一页」直接给当前 tab 的 content script 发 'tnyl:translate-page'（复用右键菜单那条通路）。

import { type BackendConfig, type BackendKind, getConfig, saveConfig } from './config';
import {
  getLanguageDisplayName,
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from './languages';

const BACKEND_LABEL: Record<BackendKind, string> = {
  chrome: 'Chrome 自带',
  deepseek: 'DeepSeek',
  custom: '自定义端点',
};

// 「换」按钮循环切换后端
const BACKEND_CYCLE: readonly BackendKind[] = ['chrome', 'deepseek', 'custom'];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[popup] missing element #${id}`);
  return el;
}

function sourceLabel(code: string): string {
  return SOURCE_LANGUAGE_OPTIONS.find((o) => o.code === code)?.label ?? code;
}

function render(cfg: BackendConfig): void {
  const nameEl = $('beName');
  nameEl.textContent = BACKEND_LABEL[cfg.active];
  const model =
    cfg.active === 'deepseek' ? cfg.deepseekModel
      : cfg.active === 'custom' ? cfg.custom.model
        : '';
  if (model) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = model;
    nameEl.append(' ', badge);
  }

  $('srcNote').textContent =
    cfg.sourceLanguage === 'auto' ? '· 自动识别源' : `· 源：${sourceLabel(cfg.sourceLanguage)}`;

  const sel = $('targetLanguage') as HTMLSelectElement;
  // 目标语言可能是 popup 下拉里没有的「冷门」语言（在 options 全列表里选的）——补一个临时 option
  if (![...sel.options].some((o) => o.value === cfg.targetLanguage)) {
    const opt = document.createElement('option');
    opt.value = cfg.targetLanguage;
    opt.textContent = getLanguageDisplayName(cfg.targetLanguage);
    sel.prepend(opt);
  }
  sel.value = cfg.targetLanguage;
}

async function init(): Promise<void> {
  (document.getElementById('logo') as HTMLImageElement).src =
    chrome.runtime.getURL('icons/icon-48.png');

  const sel = $('targetLanguage') as HTMLSelectElement;
  for (const { code, label } of TARGET_LANGUAGE_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    sel.appendChild(opt);
  }

  let cfg = await getConfig();
  render(cfg);

  sel.addEventListener('change', () => {
    cfg = { ...cfg, targetLanguage: sel.value };
    void saveConfig(cfg);
  });

  $('swapBe').addEventListener('click', () => {
    const idx = BACKEND_CYCLE.indexOf(cfg.active);
    const next = BACKEND_CYCLE[(idx + 1) % BACKEND_CYCLE.length] ?? 'chrome';
    cfg = { ...cfg, active: next };
    void saveConfig(cfg);
    render(cfg);
  });

  $('translatePage').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) {
      // content script 注入不到的页面（chrome://、商店等）会 reject——静默忽略
      chrome.tabs.sendMessage(tab.id, { type: 'tnyl:translate-page' }).catch(() => {});
    }
    window.close();
  });

  $('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

void init();
