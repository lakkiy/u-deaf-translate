// 配置页：壹「翻译」(源/目标语言) + 贰「模型」(卡片式三后端，各有可编辑的 prompt/参数)。
// 字段全在 DOM 里，切后端只调 .selected/.active class，不丢任何 tab 的输入。
// 「就这么定了」把所有字段一次性写回 storage，并把选中的卡片设为 active 后端。

import {
  DEEPSEEK_DEFAULT_EXTRA_PARAMS,
  DEEPSEEK_DEFAULT_PROMPT_TEMPLATE,
  DEEPSEEK_DEFAULT_SYSTEM,
  DEFAULT_CONFIG,
  DEFAULT_CUSTOM,
  DEFAULT_EXTRA_PARAMS,
  DEFAULT_PROMPT_TEMPLATE,
  type BackendConfig,
  type BackendKind,
  getConfig,
  saveConfig,
} from './config';
import { DEEPSEEK_ICON_SVG, DEEPSEEK_MODELS } from './deepseek';
import {
  COMMON_TARGET_CODES,
  getLanguageDisplayName,
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from './languages';
import { PROMPT_PRESETS } from './prompts';

const BACKEND_LABEL: Record<BackendKind, string> = {
  chrome: 'Chrome 自带',
  deepseek: 'DeepSeek',
  custom: '自定义端点',
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`[options] missing element #${id}`);
  return e as T;
}
const input = (id: string) => el<HTMLInputElement>(id);
const ta = (id: string) => el<HTMLTextAreaElement>(id);
const sel = (id: string) => el<HTMLSelectElement>(id);
const val = (id: string): string => (el(id) as HTMLInputElement).value;
const setVal = (id: string, v: string): void => { (el(id) as HTMLInputElement).value = v; };

function setStatus(message: string, kind: '' | 'ok' | 'error' = ''): void {
  const status = el('status');
  status.textContent = message;
  status.className = kind;
  if (kind === 'ok' && message) {
    setTimeout(() => {
      if (status.textContent === message) {
        status.textContent = '已存 · 改动按「就这么定了」保存';
        status.className = '';
      }
    }, 2500);
  }
}

// ── 后端卡片选择 ───────────────────────────────────────────
function activate(kind: BackendKind): void {
  for (const c of document.querySelectorAll<HTMLElement>('.backend-card')) {
    c.classList.toggle('selected', c.dataset.backend === kind);
  }
  for (const p of document.querySelectorAll<HTMLElement>('.panel')) {
    p.classList.toggle('active', p.dataset.panel === kind);
  }
}
function activeBackend(): BackendKind {
  const card = document.querySelector<HTMLElement>('.backend-card.selected');
  return (card?.dataset.backend as BackendKind) ?? 'chrome';
}

// ── 语言下拉 / chips ───────────────────────────────────────
function fillSelect(id: string, opts: ReadonlyArray<{ code: string; label: string }>): void {
  const s = sel(id);
  for (const o of opts) {
    const op = document.createElement('option');
    op.value = o.code;
    op.textContent = o.label;
    s.appendChild(op);
  }
}

// 目标语言可能是常用下拉里没有的「冷门」语言（之前在别处设过）——补一个临时 option
function ensureTargetOption(code: string): void {
  const s = sel('targetLanguage');
  if (![...s.options].some((o) => o.value === code)) {
    const op = document.createElement('option');
    op.value = code;
    op.textContent = getLanguageDisplayName(code);
    s.prepend(op);
  }
}

function buildCommonChips(): void {
  const box = el('commonTargets');
  for (const code of COMMON_TARGET_CODES) {
    const label = TARGET_LANGUAGE_OPTIONS.find((o) => o.code === code)?.label ?? getLanguageDisplayName(code);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.code = code;
    b.textContent = label;
    b.addEventListener('click', () => {
      ensureTargetOption(code);
      setVal('targetLanguage', code);
      syncChips();
    });
    box.appendChild(b);
  }
}
function syncChips(): void {
  const cur = val('targetLanguage');
  for (const c of el('commonTargets').querySelectorAll<HTMLElement>('.chip')) {
    c.classList.toggle('active', c.dataset.code === cur);
  }
}

// 与 translator.ts 的 reverseTarget 一致：同族文本翻向「另一边」（中↔英，其余 → 英）。
// 在 options 本地复制这一行逻辑，避免 import translator.ts（它在模块顶层注册 window 监听器、引用 Translator 全局）。
function reverseLang(target: string): string {
  return target.split('-')[0] === 'en' ? 'zh-Hans' : 'en';
}

function swapLang(): void {
  const s = val('sourceLanguage');
  const t = val('targetLanguage');
  // 目标语言不接受 'auto'。源是 'auto' 时没有具体语言可放到目标侧，交换取「从当前目标翻向它的反向」。
  const newSource = t;
  let newTarget = s === 'auto' ? reverseLang(t) : s;
  // 兜底：绝不产出 source === target 的自译退化态——否则 resolveSourceLanguage 会锁死源语言、
  // pickTargetLanguage 判同族后把所有文本都按反向翻，方向错乱（见 docs/pitfalls.md）。
  if (newSource === newTarget) newTarget = reverseLang(newSource);
  setVal('sourceLanguage', newSource);
  ensureTargetOption(newTarget);
  setVal('targetLanguage', newTarget);
  syncChips();
}

// ── DeepSeek 模型下拉 ──────────────────────────────────────
function populateDeepseekModels(): void {
  const s = sel('deepseekModel');
  for (const model of DEEPSEEK_MODELS) {
    const op = document.createElement('option');
    op.value = model;
    op.textContent = model;
    s.appendChild(op);
  }
}

// ── 提示词预设 ─────────────────────────────────────────────
function buildPresets(): void {
  for (const box of document.querySelectorAll<HTMLElement>('.presets')) {
    const backend = box.dataset.presets;
    if (!backend) continue;
    for (const p of PROMPT_PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset-btn';
      b.dataset.preset = p.id;
      b.textContent = p.label;
      b.addEventListener('click', () => {
        setVal(`${backend}-system`, p.system);
        setVal(`${backend}-promptTemplate`, p.userTemplate);
        for (const other of box.querySelectorAll<HTMLElement>('.preset-btn')) {
          other.classList.toggle('active', other.dataset.preset === p.id);
        }
      });
      box.appendChild(b);
    }
  }
}

// ── 占位符 chips：点一下塞进光标 ───────────────────────────
function wirePlaceholders(): void {
  for (const box of document.querySelectorAll<HTMLElement>('.placeholders')) {
    const targetId = box.dataset.phTarget;
    if (!targetId) continue;
    for (const b of box.querySelectorAll<HTMLElement>('.ph-btn')) {
      const text = b.dataset.ph ?? '';
      b.addEventListener('click', () => insertAtCursor(ta(targetId), text));
    }
  }
}
function insertAtCursor(area: HTMLTextAreaElement, text: string): void {
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? area.value.length;
  area.value = area.value.slice(0, start) + text + area.value.slice(end);
  const pos = start + text.length;
  area.focus();
  area.setSelectionRange(pos, pos);
}

// ── 眼睛切换显示/隐藏 ──────────────────────────────────────
function wireEyes(): void {
  for (const btn of document.querySelectorAll<HTMLElement>('.eye')) {
    const id = btn.dataset.eye;
    if (!id) continue;
    btn.addEventListener('click', () => {
      const inp = input(id);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  }
}

// ── 每后端「恢复默认」提示词 / 参数 ────────────────────────
function wireResetPrompts(): void {
  for (const btn of document.querySelectorAll<HTMLElement>('.reset-prompt')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.reset === 'deepseek') {
        setVal('deepseek-system', DEEPSEEK_DEFAULT_SYSTEM);
        setVal('deepseek-promptTemplate', DEEPSEEK_DEFAULT_PROMPT_TEMPLATE);
        setVal('deepseekExtraParams', DEEPSEEK_DEFAULT_EXTRA_PARAMS);
      } else {
        setVal('custom-system', DEFAULT_CUSTOM.system);
        setVal('custom-promptTemplate', DEFAULT_PROMPT_TEMPLATE);
        setVal('custom-extraParams', DEFAULT_EXTRA_PARAMS);
      }
      setStatus('已恢复该后端的默认提示词与参数（还没保存）');
    });
  }
}

// ── 加载 / 保存 ────────────────────────────────────────────
function loadIntoForm(cfg: BackendConfig): void {
  setVal('sourceLanguage', cfg.sourceLanguage);
  ensureTargetOption(cfg.targetLanguage);
  setVal('targetLanguage', cfg.targetLanguage);

  setVal('deepseekApiKey', cfg.deepseekApiKey);
  setVal('deepseekModel', cfg.deepseekModel);
  setVal('deepseekExtraParams', cfg.deepseekExtraParams);
  setVal('deepseek-system', cfg.deepseekSystem);
  setVal('deepseek-promptTemplate', cfg.deepseekPromptTemplate);

  setVal('custom-endpoint', cfg.custom.endpoint);
  setVal('custom-apiKey', cfg.custom.apiKey);
  setVal('custom-model', cfg.custom.model);
  setVal('custom-extraParams', cfg.custom.extraParams);
  setVal('custom-system', cfg.custom.system);
  setVal('custom-promptTemplate', cfg.custom.promptTemplate);

  activate(cfg.active);
  syncChips();
}

/** 生成参数 JSON 校验：空字符串放过；必须是 JSON 对象。 */
function validateExtraParams(text: string, who: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return `${who}的生成参数必须是 JSON 对象（{...}），不是数组或基本类型`;
    }
  } catch (err) {
    return `${who}的生成参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/** 软提示：当前激活的 LLM 后端 User 模板缺占位符（Chrome 无 prompt，跳过）。 */
function missingPlaceholders(active: BackendKind, tpl: string): string {
  if (active === 'chrome') return '';
  const miss: string[] = [];
  if (!tpl.includes('{source_text}')) miss.push('{source_text}');
  if (!tpl.includes('{target_lang}')) miss.push('{target_lang}');
  return miss.length > 0 ? `（注意：模板缺 ${miss.join(' / ')}）` : '';
}

async function handleSave(): Promise<void> {
  const dsErr = validateExtraParams(val('deepseekExtraParams'), 'DeepSeek');
  if (dsErr) { setStatus(dsErr, 'error'); return; }
  const cuErr = validateExtraParams(val('custom-extraParams'), '自定义端点');
  if (cuErr) { setStatus(cuErr, 'error'); return; }

  const active = activeBackend();
  const cfg: BackendConfig = {
    active,
    sourceLanguage: val('sourceLanguage'),
    targetLanguage: val('targetLanguage'),
    deepseekApiKey: val('deepseekApiKey'),
    deepseekModel: val('deepseekModel'),
    deepseekSystem: val('deepseek-system'),
    deepseekPromptTemplate: val('deepseek-promptTemplate') || DEEPSEEK_DEFAULT_PROMPT_TEMPLATE,
    deepseekExtraParams: val('deepseekExtraParams'),
    custom: {
      endpoint: val('custom-endpoint').trim(),
      apiKey: val('custom-apiKey'),
      model: val('custom-model').trim(),
      system: val('custom-system'),
      promptTemplate: val('custom-promptTemplate') || DEFAULT_CUSTOM.promptTemplate,
      extraParams: val('custom-extraParams').trim(),
    },
  };

  const tpl = active === 'deepseek' ? cfg.deepseekPromptTemplate : cfg.custom.promptTemplate;
  const warning = missingPlaceholders(active, tpl);

  try {
    await saveConfig(cfg);
    setStatus(`已存 · 当前用 ${BACKEND_LABEL[active]}${warning}`, warning ? 'error' : 'ok');
  } catch (err) {
    setStatus(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

// 底部「恢复默认」：重置语言与提示词/参数；保留 Key / 端点 / 模型这类连接信息。
function handleResetAll(): void {
  const d = DEFAULT_CONFIG;
  setVal('sourceLanguage', d.sourceLanguage);
  ensureTargetOption(d.targetLanguage);
  setVal('targetLanguage', d.targetLanguage);
  setVal('deepseekExtraParams', d.deepseekExtraParams);
  setVal('deepseek-system', d.deepseekSystem);
  setVal('deepseek-promptTemplate', d.deepseekPromptTemplate);
  setVal('custom-extraParams', d.custom.extraParams);
  setVal('custom-system', d.custom.system);
  setVal('custom-promptTemplate', d.custom.promptTemplate);
  syncChips();
  setStatus('已恢复语言与提示词默认（保留了 Key / 端点 / 模型；还没保存）');
}

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLImageElement>('logo').src = chrome.runtime.getURL('icons/icon-48.png');
  el('version').textContent = `v${chrome.runtime.getManifest().version}`;
  el('deepseek-icon').innerHTML = DEEPSEEK_ICON_SVG;

  fillSelect('sourceLanguage', SOURCE_LANGUAGE_OPTIONS);
  fillSelect('targetLanguage', TARGET_LANGUAGE_OPTIONS);
  buildCommonChips();
  populateDeepseekModels();
  buildPresets();
  wirePlaceholders();
  wireEyes();
  wireResetPrompts();

  for (const c of document.querySelectorAll<HTMLElement>('.backend-card')) {
    c.addEventListener('click', () => activate(c.dataset.backend as BackendKind));
  }
  el('swapLang').addEventListener('click', swapLang);
  sel('targetLanguage').addEventListener('change', syncChips);
  el('save').addEventListener('click', () => void handleSave());
  el('reset').addEventListener('click', handleResetAll);

  getConfig().then(loadIntoForm).catch((err) => setStatus(`加载配置失败：${err}`, 'error'));
});
