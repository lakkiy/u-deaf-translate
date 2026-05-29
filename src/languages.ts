// Hy-MT2 支持的 37 种语言：BCP-47 → 中文名映射。
// 用途：LLM prompt 渲染时把 target_lang 替换为中文名（"中文" / "英语" 等），
// 比 Intl.DisplayNames 更可控（譬如 'zh' 这里固定为"中文"而不是"汉语"）。
// 数据来源：https://huggingface.co/mlx-community/Hy-MT2-1.8B-4bit Supported Languages 表。

export const LANGUAGE_NAMES: Record<string, string> = {
  zh: '中文',
  en: '英语',
  fr: '法语',
  pt: '葡萄牙语',
  es: '西班牙语',
  ja: '日语',
  tr: '土耳其语',
  ru: '俄语',
  ar: '阿拉伯语',
  ko: '韩语',
  th: '泰语',
  it: '意大利语',
  de: '德语',
  vi: '越南语',
  ms: '马来语',
  id: '印尼语',
  tl: '菲律宾语',
  hi: '印地语',
  'zh-Hant': '繁体中文',
  pl: '波兰语',
  cs: '捷克语',
  nl: '荷兰语',
  km: '高棉语',
  my: '缅甸语',
  fa: '波斯语',
  gu: '古吉拉特语',
  ur: '乌尔都语',
  te: '泰卢固语',
  mr: '马拉地语',
  he: '希伯来语',
  bn: '孟加拉语',
  ta: '泰米尔语',
  uk: '乌克兰语',
  bo: '藏语',
  kk: '哈萨克语',
  mn: '蒙古语',
  ug: '维吾尔语',
  yue: '粤语',
};

/**
 * 取语言的人类可读中文名。先查完整 BCP-47 code（保留 zh-Hant 这种细分），
 * 没命中再退到主子标签（zh-CN → zh → 中文）。最后兜底用 Intl.DisplayNames，
 * 还不行就返回 code 本身。
 */
export function getLanguageDisplayName(code: string): string {
  if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];
  const primary = code.split('-')[0];
  if (primary && LANGUAGE_NAMES[primary]) return LANGUAGE_NAMES[primary];
  try {
    return new Intl.DisplayNames(['zh-Hans'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
