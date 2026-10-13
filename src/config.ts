// 用户配置：三种翻译后端互斥选择，每种独立保存字段（切后端不丢内容）。
// 存在 chrome.storage.sync 里；options / popup 写，content script 读。
// 各后端的固定值与默认值也都在这一个文件里。

export type BackendKind = 'chrome' | 'deepseek' | 'custom';

export const BACKEND_LABEL: Record<BackendKind, string> = {
  chrome: 'Chrome 自带',
  deepseek: 'DeepSeek',
  custom: '自定义端点',
};

// DeepSeek 的 endpoint 内置、模型从下拉选（列表顺序 = 下拉显示顺序，第一个是默认）。
// 官方文档（api-docs.deepseek.com/zh-cn/api/create-chat-completion）的路径是 /chat/completions，没有 /v1。
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;

/** 一个 OpenAI 兼容后端要的全部字段。custom 后端原样存；DeepSeek 由 translate.ts 拼出同样的形状。 */
export interface CustomBackendFields {
  endpoint: string;
  apiKey: string;
  model: string;
  /** System / 角色设定（可选）；空则不发 system 消息 */
  system: string;
  /** User 消息模板；占位符 {target_lang} / {source_text} */
  promptTemplate: string;
  /** 额外生成参数（JSON 对象文本）；空则不附加 */
  extraParams: string;
}

export interface BackendConfig {
  /** 当前生效的后端 */
  active: BackendKind;
  /** 源语言；'auto' = 自动检测 */
  sourceLanguage: string;
  /** 目标语言；BCP-47，如 'zh-Hans'。选中文本与它同族时翻向另一边（见 languages.ts） */
  targetLanguage: string;
  deepseekApiKey: string;
  /** 值来自 DEEPSEEK_MODELS */
  deepseekModel: string;
  deepseekSystem: string;
  deepseekPromptTemplate: string;
  deepseekExtraParams: string;
  custom: CustomBackendFields;
}

// 默认值：新装时的初始配置，也是 options 页「恢复默认」的来源。
export const DEFAULT_CONFIG: BackendConfig = {
  active: 'chrome',
  sourceLanguage: 'auto',
  targetLanguage: 'zh-Hans',
  deepseekApiKey: '',
  deepseekModel: DEEPSEEK_MODELS[0],
  deepseekSystem: '',
  // Hy-MT2 官方推荐的 prompt 格式
  deepseekPromptTemplate:
    '将以下文本翻译为 {target_lang}，注意只需要输出翻译后的结果，不要额外解释：\n\n{source_text}',
  // thinking.type=disabled 不能丢：开思考模式会让 v4-pro 延迟暴涨且响应混入 reasoning。
  deepseekExtraParams: '{"temperature": 1.3, "max_tokens": 1024, "thinking": {"type": "disabled"}}',
  // 自定义端点默认指向本地 llama.cpp server，提示词与参数取 Index-Translate 模型卡的推荐：
  // 贪心解码（temperature 0）+ 关 thinking。chat_template_kwargs 是 llama.cpp server 的请求级开关，
  // 换成不认这个字段的服务（如 OpenAI 官方）时要在 options 里删掉。
  custom: {
    endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    apiKey: '',
    model: '',
    system: '',
    promptTemplate:
      '请将以下文本翻译为{target_lang}，直接输出翻译结果，不要进行任何解释。\n\n{source_text}',
    extraParams: '{"temperature": 0, "chat_template_kwargs": {"enable_thinking": false}}',
  },
};

// module-level cache：避免每次翻译都打一次 storage。onChanged 事件触发时失效。
let cached: BackendConfig | null = null;

export async function getConfig(): Promise<BackendConfig> {
  if (cached) return cached;
  const stored = (await chrome.storage.sync.get()) as Partial<BackendConfig>;
  // 缺的字段用默认值兜底（新增字段对老用户透明升级，不破坏已存配置）
  cached = {
    ...DEFAULT_CONFIG,
    ...stored,
    custom: { ...DEFAULT_CONFIG.custom, ...stored.custom },
  };
  return cached;
}

export async function saveConfig(cfg: BackendConfig): Promise<void> {
  await chrome.storage.sync.set(cfg);
  cached = null;
}

// options / popup 保存后，其他上下文通过 storage.onChanged 收到事件
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') cached = null;
});
