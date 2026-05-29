// LLM 翻译后端：通过 background service worker 代理 fetch（避免 content script 受页面 CORS 限制）。
// 协议：OpenAI 兼容 chat completions。endpoint 是完整 URL（含 /v1/chat/completions）。

import type { CustomBackendFields } from './config';
import { getLanguageDisplayName } from './languages';

interface LlmFetchRequest {
  type: 'tnyl:llm-fetch';
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface LlmFetchResponse {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

/** content script → background：发请求并 await 响应。background 端 return true 保持 channel 开放。 */
async function proxyFetch(req: Omit<LlmFetchRequest, 'type'>): Promise<LlmFetchResponse> {
  return chrome.runtime.sendMessage({ type: 'tnyl:llm-fetch', ...req });
}

function renderPrompt(template: string, targetLang: string, sourceText: string): string {
  // 简单字符串替换：占位符 {target_lang} / {source_text}。
  // 不做转义——LLM 自己能处理 prompt 内的特殊字符；用户填的模板我们尊重。
  return template
    .replaceAll('{target_lang}', targetLang)
    .replaceAll('{source_text}', sourceText);
}

/**
 * OpenAI chat completions 协议。响应取 choices[0].message.content。
 * 错误（非 2xx / 网络失败 / 解析失败）抛中文错误。
 */
export async function translateViaLlm(
  text: string,
  targetLanguage: string,
  config: CustomBackendFields,
): Promise<string> {
  const targetName = getLanguageDisplayName(targetLanguage);
  const prompt = renderPrompt(config.promptTemplate, targetName, text);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  // base body：messages 总要发。model 仅在用户填了才发——
  // mlx_lm.server 收到不匹配的 model 会去重新 download/load，找不到就 HTTP 404。
  // 不发 model 字段时 server 用当前加载的 model，最稳。
  const bodyObj: Record<string, unknown> = {
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
  if (config.model.trim()) {
    bodyObj.model = config.model.trim();
  }
  // merge 用户填的额外参数（max_tokens / temperature / top_p / top_k 等）
  if (config.extraParams.trim()) {
    try {
      const extra = JSON.parse(config.extraParams) as Record<string, unknown>;
      Object.assign(bodyObj, extra);
    } catch (err) {
      throw new Error(`额外参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const body = JSON.stringify(bodyObj);

  const resp = await proxyFetch({ url: config.endpoint, headers, body });

  if (!resp.ok) {
    const detail = resp.error ?? `HTTP ${resp.status ?? '?'}`;
    console.error('[叫你翻译你聋吗] LLM 后端请求失败:', detail);
    throw new Error(`LLM 后端请求失败：${detail}`);
  }

  const data = resp.data as
    | { choices?: Array<{ message?: { content?: string } }> }
    | undefined;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    console.error('[叫你翻译你聋吗] LLM 响应缺少 choices[0].message.content:', data);
    throw new Error('LLM 返回空内容（响应结构与 OpenAI chat completions 不一致？）');
  }
  return content.trim();
}
