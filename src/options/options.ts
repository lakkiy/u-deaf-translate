// 配置页：壹「翻译」(源/目标语言) + 贰「模型」(卡片式三后端，各有可编辑的 prompt/参数)。
// 字段全在 DOM 里，切后端只调 .selected/.active class，不丢任何后端的输入。
// 「就这么定了」把所有字段一次性写回 storage，并把选中的卡片设为 active 后端。
// 两个 LLM 后端的输入框 id 统一是 `${后端}-${字段}`（deepseek-apiKey / custom-endpoint …）。

import {
  BACKEND_LABEL,
  DEEPSEEK_MODELS,
  DEFAULT_CONFIG,
  type BackendConfig,
  type BackendKind,
  getConfig,
  saveConfig,
} from '../config';
import {
  COMMON_TARGET_CODES,
  reverseTarget,
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
} from '../languages';
import { PROMPT_PRESETS } from './prompts';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`[options] missing element #${id}`);
  return e as T;
}
// input / select / textarea 都有 .value，统一按 input 读写
const val = (id: string): string => el<HTMLInputElement>(id).value;
const setVal = (id: string, v: string): void => { el<HTMLInputElement>(id).value = v; };

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

// ── 下拉 / 语言 chips ──────────────────────────────────────
function fillSelect(id: string, opts: ReadonlyArray<{ code: string; label: string }>): void {
  const s = el(id);
  for (const o of opts) {
    const op = document.createElement('option');
    op.value = o.code;
    op.textContent = o.label;
    s.appendChild(op);
  }
}

function buildCommonChips(): void {
  const box = el('commonTargets');
  for (const code of COMMON_TARGET_CODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.code = code;
    b.textContent = TARGET_LANGUAGE_OPTIONS.find((o) => o.code === code)?.label ?? code;
    b.addEventListener('click', () => {
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

function swapLang(): void {
  const s = val('sourceLanguage');
  const t = val('targetLanguage');
  // 目标语言不接受 'auto'。源是 'auto' 时没有具体语言可放到目标侧，交换取「从当前目标翻向它的反向」。
  let newTarget = s === 'auto' ? reverseTarget(t) : s;
  // 兜底：绝不产出 source === target 的自译退化态——否则 resolveSourceLanguage 会锁死源语言、
  // pickTargetLanguage 判同族后把所有文本都按反向翻，方向错乱（见 docs/pitfalls.md）。
  if (newTarget === t) newTarget = reverseTarget(t);
  setVal('sourceLanguage', t);
  setVal('targetLanguage', newTarget);
  syncChips();
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
      b.addEventListener('click', () => insertAtCursor(el<HTMLTextAreaElement>(targetId), text));
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
      const inp = el<HTMLInputElement>(id);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  }
}

// ── 恢复默认 ───────────────────────────────────────────────
// 只重置提示词 / 生成参数；Key / 端点 / 模型这类连接信息不动。
function resetDeepseekPrompts(): void {
  setVal('deepseek-system', DEFAULT_CONFIG.deepseekSystem);
  setVal('deepseek-promptTemplate', DEFAULT_CONFIG.deepseekPromptTemplate);
  setVal('deepseek-extraParams', DEFAULT_CONFIG.deepseekExtraParams);
}
function resetCustomPrompts(): void {
  setVal('custom-system', DEFAULT_CONFIG.custom.system);
  setVal('custom-promptTemplate', DEFAULT_CONFIG.custom.promptTemplate);
  setVal('custom-extraParams', DEFAULT_CONFIG.custom.extraParams);
}

// 每个 LLM 后端面板里的「恢复默认」
function wireResetPrompts(): void {
  for (const btn of document.querySelectorAll<HTMLElement>('.reset-prompt')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.reset === 'deepseek') resetDeepseekPrompts();
      else resetCustomPrompts();
      setStatus('已恢复该后端的默认提示词与参数（还没保存）');
    });
  }
}

// 底部「恢复默认」：语言 + 两个后端的提示词/参数
function handleResetAll(): void {
  setVal('sourceLanguage', DEFAULT_CONFIG.sourceLanguage);
  setVal('targetLanguage', DEFAULT_CONFIG.targetLanguage);
  resetDeepseekPrompts();
  resetCustomPrompts();
  syncChips();
  setStatus('已恢复语言与提示词默认（保留了 Key / 端点 / 模型；还没保存）');
}

// ── 加载 / 保存 ────────────────────────────────────────────
function loadIntoForm(cfg: BackendConfig): void {
  setVal('sourceLanguage', cfg.sourceLanguage);
  setVal('targetLanguage', cfg.targetLanguage);

  setVal('deepseek-apiKey', cfg.deepseekApiKey);
  setVal('deepseek-model', cfg.deepseekModel);
  setVal('deepseek-extraParams', cfg.deepseekExtraParams);
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
  const dsErr = validateExtraParams(val('deepseek-extraParams'), 'DeepSeek');
  if (dsErr) { setStatus(dsErr, 'error'); return; }
  const cuErr = validateExtraParams(val('custom-extraParams'), '自定义端点');
  if (cuErr) { setStatus(cuErr, 'error'); return; }

  const active = activeBackend();
  // User 模板清空了就退回默认——空模板发出去等于没给模型任何原文
  const cfg: BackendConfig = {
    active,
    sourceLanguage: val('sourceLanguage'),
    targetLanguage: val('targetLanguage'),
    deepseekApiKey: val('deepseek-apiKey'),
    deepseekModel: val('deepseek-model'),
    deepseekSystem: val('deepseek-system'),
    deepseekPromptTemplate: val('deepseek-promptTemplate') || DEFAULT_CONFIG.deepseekPromptTemplate,
    deepseekExtraParams: val('deepseek-extraParams'),
    custom: {
      endpoint: val('custom-endpoint').trim(),
      apiKey: val('custom-apiKey'),
      model: val('custom-model').trim(),
      system: val('custom-system'),
      promptTemplate: val('custom-promptTemplate') || DEFAULT_CONFIG.custom.promptTemplate,
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

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLImageElement>('logo').src = chrome.runtime.getURL('icons/icon-48.png');
  el('version').textContent = `v${chrome.runtime.getManifest().version}`;

  fillSelect('sourceLanguage', SOURCE_LANGUAGE_OPTIONS);
  fillSelect('targetLanguage', TARGET_LANGUAGE_OPTIONS);
  fillSelect('deepseek-model', DEEPSEEK_MODELS.map((m) => ({ code: m, label: m })));
  buildCommonChips();
  buildPresets();
  wirePlaceholders();
  wireEyes();
  wireResetPrompts();

  for (const c of document.querySelectorAll<HTMLElement>('.backend-card')) {
    c.addEventListener('click', () => activate(c.dataset.backend as BackendKind));
  }
  el('swapLang').addEventListener('click', swapLang);
  el('targetLanguage').addEventListener('change', syncChips);
  el('save').addEventListener('click', () => void handleSave());
  el('reset').addEventListener('click', handleResetAll);

  getConfig().then(loadIntoForm).catch((err) => setStatus(`加载配置失败：${err}`, 'error'));
});
