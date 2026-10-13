// 翻译入口：定源语言 → 选目标语言 → 按配置的后端分发。
// 上层（content/）只用这里的两个函数，不感知具体后端：
//   chrome.ts —— Chrome 内置 Translator / LanguageDetector（默认；零联网）
//   llm.ts    —— OpenAI 兼容的 chat completions（DeepSeek / 自定义端点共用）

import { DEEPSEEK_ENDPOINT, getConfig } from '../config';
import { pickTargetLanguage } from '../languages';
import { type DetectResult, detectLanguage, translateViaChrome } from './chrome';
import { translateViaLlm } from './llm';

/**
 * 解析源语言：config.sourceLanguage 非 'auto' 时直接用用户指定的源语言（跳过检测）；
 * 否则自动检测。划词与整页两条路径共用，保证手动指定源语言能生效。
 */
export async function resolveSourceLanguage(text: string): Promise<DetectResult> {
  const cfg = await getConfig();
  if (cfg.sourceLanguage && cfg.sourceLanguage !== 'auto') {
    return { language: cfg.sourceLanguage, uncertain: false };
  }
  return detectLanguage(text);
}

/** 翻译。根据 config.active 三选一分发（chrome / deepseek / custom）。 */
export async function translate(text: string, sourceLanguage: string): Promise<string> {
  const cfg = await getConfig();
  // pickTargetLanguage 保证源与目标不同族（同族走智能反向），无需再判同族跳过。
  const targetLanguage = pickTargetLanguage(sourceLanguage, cfg.targetLanguage);

  switch (cfg.active) {
    case 'chrome':
      return translateViaChrome(text, sourceLanguage, targetLanguage);
    case 'deepseek':
      // DeepSeek endpoint 内置；其余字段来自用户配置
      return translateViaLlm(text, targetLanguage, {
        endpoint: DEEPSEEK_ENDPOINT,
        apiKey: cfg.deepseekApiKey,
        model: cfg.deepseekModel,
        system: cfg.deepseekSystem,
        promptTemplate: cfg.deepseekPromptTemplate,
        extraParams: cfg.deepseekExtraParams,
      });
    case 'custom':
      return translateViaLlm(text, targetLanguage, cfg.custom);
  }
}
