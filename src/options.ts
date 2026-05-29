// 配置页面：三个 tab（Chrome / DeepSeek / 自定义）互斥选择。
// 字段都在 DOM 里渲染，切 tab 只调 .active class，不丢用户输入。
// 保存按钮把所有 tab 的字段一次性写回 storage，并把当前激活 tab 设为 active。

import {
  DEFAULT_CUSTOM,
  DEFAULT_EXTRA_PARAMS,
  DEFAULT_PROMPT_TEMPLATE,
  type BackendConfig,
  type BackendKind,
  getConfig,
  saveConfig,
} from './config';
import { DEEPSEEK_ICON_SVG, DEEPSEEK_MODELS } from './deepseek';

function $(id: string): HTMLInputElement | HTMLTextAreaElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[options] missing element #${id}`);
  return el as HTMLInputElement | HTMLTextAreaElement;
}

function $select(id: string): HTMLSelectElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[options] missing element #${id}`);
  return el as HTMLSelectElement;
}

function setStatus(message: string, isError = false): void {
  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
  if (!isError && message) {
    setTimeout(() => {
      if (status.textContent === message) status.textContent = '';
    }, 2500);
  }
}

function activateTab(kind: BackendKind): void {
  for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === kind);
  }
  for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    panel.classList.toggle('active', panel.dataset.panel === kind);
  }
}

function getActiveTab(): BackendKind {
  const active = document.querySelector<HTMLElement>('.tab.active');
  return (active?.dataset.tab as BackendKind) ?? 'chrome';
}

function loadIntoForm(cfg: BackendConfig): void {
  $('deepseekApiKey').value = cfg.deepseekApiKey;
  $select('deepseekModel').value = cfg.deepseekModel;
  $('custom-endpoint').value = cfg.custom.endpoint;
  $('custom-apiKey').value = cfg.custom.apiKey;
  $('custom-model').value = cfg.custom.model;
  $('custom-promptTemplate').value = cfg.custom.promptTemplate;
  $('custom-extraParams').value = cfg.custom.extraParams;
  activateTab(cfg.active);
}

function populateDeepseekModels(): void {
  const select = $select('deepseekModel');
  for (const model of DEEPSEEK_MODELS) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    select.appendChild(opt);
  }
}

/** 自定义 tab 的 JSON 校验：保存前必须通过 */
function validateCustomExtraParams(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return '自定义后端的额外参数必须是 JSON 对象（{...}），不是数组或基本类型';
    }
  } catch (err) {
    return `自定义后端的额外参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

async function handleSave(): Promise<void> {
  const customExtraParams = $('custom-extraParams').value.trim();
  const validationError = validateCustomExtraParams(customExtraParams);
  if (validationError) {
    setStatus(validationError, true);
    return;
  }

  const cfg: BackendConfig = {
    active: getActiveTab(),
    deepseekApiKey: $('deepseekApiKey').value,
    deepseekModel: $select('deepseekModel').value,
    custom: {
      endpoint: $('custom-endpoint').value.trim(),
      apiKey: $('custom-apiKey').value,
      model: $('custom-model').value.trim(),
      promptTemplate: $('custom-promptTemplate').value || DEFAULT_CUSTOM.promptTemplate,
      extraParams: customExtraParams,
    },
  };

  // 软提示：自定义模板缺占位符
  const tpl = cfg.custom.promptTemplate;
  const missing: string[] = [];
  if (cfg.active === 'custom') {
    if (!tpl.includes('{source_text}')) missing.push('{source_text}');
    if (!tpl.includes('{target_lang}')) missing.push('{target_lang}');
  }

  try {
    await saveConfig(cfg);
    const tabLabel = cfg.active === 'chrome' ? 'Chrome 内置'
      : cfg.active === 'deepseek' ? 'DeepSeek'
        : '自定义';
    const warning = missing.length > 0
      ? `（注意：自定义模板缺少 ${missing.join(' / ')}）`
      : '';
    setStatus(`已保存，当前使用 ${tabLabel}${warning}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`保存失败：${msg}`, true);
  }
}

function handleResetCustom(): void {
  $('custom-promptTemplate').value = DEFAULT_PROMPT_TEMPLATE;
  $('custom-extraParams').value = DEFAULT_EXTRA_PARAMS;
  setStatus('已恢复自定义 tab 的默认 prompt & 参数（还没保存）');
}

document.addEventListener('DOMContentLoaded', () => {
  // DeepSeek logo SVG 注入到 tab icon 占位
  const iconHost = document.getElementById('deepseek-icon');
  if (iconHost) iconHost.innerHTML = DEEPSEEK_ICON_SVG;

  // DeepSeek model 下拉选项 —— 必须在 loadIntoForm 之前 populate，
  // 否则 setting value 会被忽略（option 还不存在）
  populateDeepseekModels();

  // tab 点击切换显示
  for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
    tab.addEventListener('click', () => {
      const kind = tab.dataset.tab as BackendKind | undefined;
      if (kind) activateTab(kind);
    });
  }

  getConfig()
    .then(loadIntoForm)
    .catch((err) => setStatus(`加载配置失败：${err}`, true));

  document.getElementById('save')?.addEventListener('click', () => void handleSave());
  document.getElementById('reset-custom')?.addEventListener('click', handleResetCustom);
});
