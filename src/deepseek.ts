// DeepSeek 后端的固定配置：用户在 options 页面只需要填 API Key，
// endpoint/model/生成参数都按 DeepSeek 官方推荐写死，对翻译场景已经够好。

import { DEFAULT_PROMPT_TEMPLATE } from './config';

// 官方文档（api-docs.deepseek.com/zh-cn/api/create-chat-completion）的路径是 /chat/completions，没有 /v1。
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

/** DeepSeek 可选模型；列表顺序 = options 页 select 显示顺序，第一个是默认。 */
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;
export type DeepseekModel = (typeof DEEPSEEK_MODELS)[number];
export const DEEPSEEK_DEFAULT_MODEL: DeepseekModel = 'deepseek-v4-flash';
// DeepSeek 官方对翻译/通用对话推荐 temperature=1.3；max_tokens 给 1024 兼顾长段落。
// thinking.type = "disabled"：关闭思考模式（默认 enabled）——翻译任务不需要推理，
// 启用 thinking 会让 v4-pro 返回延迟显著变高，且响应里可能混入 reasoning 内容。
export const DEEPSEEK_EXTRA_PARAMS =
  '{"temperature": 1.3, "max_tokens": 1024, "thinking": {"type": "disabled"}}';
export const DEEPSEEK_PROMPT_TEMPLATE = DEFAULT_PROMPT_TEMPLATE;

// 品牌主色 #4D6BFE；图形用一道白色波浪表达 "deep sea"
export const DEEPSEEK_ICON_SVG = `
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="16" cy="16" r="16" fill="#4D6BFE"/>
  <path d="M6 19 Q10 13 14 19 T22 19 T30 19" stroke="white" stroke-width="2"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`.trim();
