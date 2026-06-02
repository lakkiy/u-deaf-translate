// DeepSeek 后端的固定配置：endpoint 内置、模型从下拉选。
// system / prompt / 生成参数的默认值已移到 config.ts 的 DEEPSEEK_DEFAULT_* 常量，
// 因为它们现在是用户可在 options 编辑的配置字段（首次默认值 + 「恢复默认」用那组常量）。

// 官方文档（api-docs.deepseek.com/zh-cn/api/create-chat-completion）的路径是 /chat/completions，没有 /v1。
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';

/** DeepSeek 可选模型；列表顺序 = options 页 select 显示顺序，第一个是默认。 */
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const;
export type DeepseekModel = (typeof DEEPSEEK_MODELS)[number];
export const DEEPSEEK_DEFAULT_MODEL: DeepseekModel = 'deepseek-v4-flash';

// 品牌主色 #4D6BFE；图形用一道白色波浪表达 "deep sea"
export const DEEPSEEK_ICON_SVG = `
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="16" cy="16" r="16" fill="#4D6BFE"/>
  <path d="M6 19 Q10 13 14 19 T22 19 T30 19" stroke="white" stroke-width="2"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`.trim();
