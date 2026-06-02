// 用户配置：三种翻译后端互斥选择，每种独立保存字段（切 tab 不丢内容）。
// 存在 chrome.storage.sync 里；options 写、content/background 读。

export type BackendKind = 'chrome' | 'deepseek' | 'custom';

// 默认 prompt 模板：Hy-MT2 官方推荐格式。{target_lang} 替换为中文名、{source_text} 替换为选中文本。
export const DEFAULT_PROMPT_TEMPLATE =
  `将以下文本翻译为 {target_lang}，注意只需要输出翻译后的结果，不要额外解释：

{source_text}`;

// 通用生成参数默认值。temperature/top_p/top_k 用 Hy-MT2 模型卡推荐值；
// max_tokens 用 1024 而非模型卡示例的 128——整页翻译的长段落 128 token（约 90 汉字）会被截断。
export const DEFAULT_EXTRA_PARAMS =
  '{"max_tokens": 1024, "temperature": 0.7, "top_p": 0.6, "top_k": 20}';

// 源/目标语言默认值。源 'auto' = 自动检测（保持原有行为）；目标 'zh-Hans' = 简体中文。
// 二者都可在 options / popup 修改。pickTargetLanguage 仍保留「源与目标同族 → 翻向另一边」的智能反向。
export const DEFAULT_SOURCE_LANGUAGE = 'auto';
export const DEFAULT_TARGET_LANGUAGE = 'zh-Hans';

// DeepSeek 的默认 system / prompt / 生成参数。原先写死在 deepseek.ts，现做成可在 options 编辑的字段，
// 这些常量只作首次默认值与「恢复默认」。system 默认空字符串 = 保持原先只发 user 单条消息的行为。
// extraParams 里 thinking.type=disabled 不能丢：开思考模式会让 v4-pro 延迟暴涨且响应混入 reasoning。
export const DEEPSEEK_DEFAULT_SYSTEM = '';
export const DEEPSEEK_DEFAULT_PROMPT_TEMPLATE = DEFAULT_PROMPT_TEMPLATE;
export const DEEPSEEK_DEFAULT_EXTRA_PARAMS =
  '{"temperature": 1.3, "max_tokens": 1024, "thinking": {"type": "disabled"}}';

export interface CustomBackendFields {
  endpoint: string;
  apiKey: string;
  model: string;
  /** System / 角色设定（可选）；空则不发 system 消息 */
  system: string;
  promptTemplate: string;
  extraParams: string;
}

export interface BackendConfig {
  /** 当前生效的后端 */
  active: BackendKind;
  /** 源语言；'auto' = 自动检测 */
  sourceLanguage: string;
  /** 目标语言（主目标）；BCP-47，如 'zh-Hans'。同族文本走智能反向 */
  targetLanguage: string;
  /** DeepSeek API Key（必填）；endpoint 固定在 deepseek.ts */
  deepseekApiKey: string;
  /** DeepSeek 模型选项；值来自 DEEPSEEK_MODELS（'deepseek-v4-flash' / 'deepseek-v4-pro'） */
  deepseekModel: string;
  /** DeepSeek 的 system / prompt / 生成参数（可编辑；默认取上面 DEEPSEEK_DEFAULT_* 常量） */
  deepseekSystem: string;
  deepseekPromptTemplate: string;
  deepseekExtraParams: string;
  /** 自定义后端的完整字段 */
  custom: CustomBackendFields;
}

export const DEFAULT_CUSTOM: CustomBackendFields = {
  endpoint: '',
  apiKey: '',
  model: '',
  system: '',
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  extraParams: DEFAULT_EXTRA_PARAMS,
};

// DEFAULT_CONFIG 不直接 import DEEPSEEK_DEFAULT_MODEL（避免 config ↔ deepseek 循环 import），
// 用字符串字面量；DEEPSEEK_MODELS 数组里要保持 'deepseek-v4-flash' 是第一个。
export const DEFAULT_CONFIG: BackendConfig = {
  active: 'chrome',
  sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  deepseekApiKey: '',
  deepseekModel: 'deepseek-v4-flash',
  deepseekSystem: DEEPSEEK_DEFAULT_SYSTEM,
  deepseekPromptTemplate: DEEPSEEK_DEFAULT_PROMPT_TEMPLATE,
  deepseekExtraParams: DEEPSEEK_DEFAULT_EXTRA_PARAMS,
  custom: { ...DEFAULT_CUSTOM },
};

// module-level cache：避免每次翻译都打一次 storage。onChanged 事件触发时失效。
let cached: BackendConfig | null = null;

interface LegacyFlatConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  promptTemplate?: string;
  extraParams?: string;
}

/**
 * 旧 schema 是扁平字段（endpoint/apiKey/model/...）直接放 storage 根；新 schema 嵌套到 custom 下。
 * 第一次读到旧数据时把它 move 进 custom，active 设为 'custom'（用户之前配过 endpoint 肯定是想用自定义）。
 * 迁移结果立即 set 回 storage，旧字段 remove，下次就不再走这条路径。
 */
async function migrateLegacyIfNeeded(stored: Record<string, unknown>): Promise<BackendConfig | null> {
  const legacy = stored as LegacyFlatConfig;
  const hasLegacy = typeof legacy.endpoint === 'string' && legacy.endpoint !== '';
  const hasNew = typeof stored.active === 'string' || typeof stored.custom === 'object';
  if (!hasLegacy || hasNew) return null;

  const migrated: BackendConfig = {
    active: 'custom',
    sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    deepseekApiKey: '',
    deepseekModel: DEFAULT_CONFIG.deepseekModel,
    deepseekSystem: DEEPSEEK_DEFAULT_SYSTEM,
    deepseekPromptTemplate: DEEPSEEK_DEFAULT_PROMPT_TEMPLATE,
    deepseekExtraParams: DEEPSEEK_DEFAULT_EXTRA_PARAMS,
    custom: {
      endpoint: legacy.endpoint ?? '',
      apiKey: legacy.apiKey ?? '',
      model: legacy.model ?? '',
      system: '',
      promptTemplate: legacy.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE,
      extraParams: legacy.extraParams ?? DEFAULT_EXTRA_PARAMS,
    },
  };
  await chrome.storage.sync.set(migrated);
  await chrome.storage.sync.remove(['endpoint', 'apiKey', 'model', 'promptTemplate', 'extraParams']);
  console.log('[叫你翻译你聋吗] 旧配置已迁移到 custom backend');
  return migrated;
}

export async function getConfig(): Promise<BackendConfig> {
  if (cached) return cached;
  const stored = await chrome.storage.sync.get();
  const migrated = await migrateLegacyIfNeeded(stored);
  if (migrated) {
    cached = migrated;
    return cached;
  }
  // merge：缺字段的用默认值兜底（新增字段对老用户透明升级，不破坏已存配置）
  cached = {
    active: (stored.active as BackendKind) ?? DEFAULT_CONFIG.active,
    sourceLanguage: (stored.sourceLanguage as string) ?? DEFAULT_SOURCE_LANGUAGE,
    targetLanguage: (stored.targetLanguage as string) ?? DEFAULT_TARGET_LANGUAGE,
    deepseekApiKey: (stored.deepseekApiKey as string) ?? '',
    deepseekModel: (stored.deepseekModel as string) ?? DEFAULT_CONFIG.deepseekModel,
    deepseekSystem: (stored.deepseekSystem as string) ?? DEEPSEEK_DEFAULT_SYSTEM,
    deepseekPromptTemplate: (stored.deepseekPromptTemplate as string) ?? DEEPSEEK_DEFAULT_PROMPT_TEMPLATE,
    deepseekExtraParams: (stored.deepseekExtraParams as string) ?? DEEPSEEK_DEFAULT_EXTRA_PARAMS,
    custom: { ...DEFAULT_CUSTOM, ...(stored.custom as Partial<CustomBackendFields> | undefined) },
  };
  return cached;
}

export async function saveConfig(cfg: BackendConfig): Promise<void> {
  await chrome.storage.sync.set(cfg);
  cached = null;
}

// options 页面保存后，content / background 通过 storage.onChanged 收到事件
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') cached = null;
});
