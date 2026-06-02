// options 页「提示词」区的预设。点一下把 system + userTemplate 填进可编辑框（之后还能手改）。
// 占位符沿用单括号 {target_lang} / {source_text}，与 llm-backend.ts 的 renderPrompt 一致。
// 这些只是初版文案，给用户一个起点；DeepSeek / 自定义两个后端共用同一组预设。

export interface PromptPreset {
  id: string;
  label: string;
  system: string;
  userTemplate: string;
}

export const PROMPT_PRESETS: ReadonlyArray<PromptPreset> = [
  {
    id: 'literal',
    label: '直译',
    system: '你是专业翻译，只输出译文，不解释。',
    userTemplate:
      '将下面的文本逐句翻译为 {target_lang}，尽量贴近原文的结构与措辞，不要意译、不要发挥：\n\n{source_text}',
  },
  {
    id: 'idiomatic',
    label: '意译',
    system: '你是个翻译，说人话，不绕弯。',
    userTemplate:
      '把下面这段翻成 {target_lang}，要求：\n– 通顺、说人话，别端着\n– 专有名词、品牌名保留原文\n– 不要解释、不要加引号\n\n{source_text}',
  },
  {
    id: 'colloquial',
    label: '口语化',
    system: '你是个会聊天的翻译，用日常口语表达。',
    userTemplate:
      '用自然、口语化的 {target_lang} 重新表达下面这段，像跟朋友讲话一样，但不要改变原意。只输出结果：\n\n{source_text}',
  },
  {
    id: 'technical',
    label: '术语优先',
    system: '你是技术文档翻译，优先保证术语准确。',
    userTemplate:
      '把下面的技术文本翻成 {target_lang}，要求：\n– 专业术语用业界通行译法，拿不准的在括号里附原文\n– 代码、命令、标识符保留原文\n– 只输出译文\n\n{source_text}',
  },
];
