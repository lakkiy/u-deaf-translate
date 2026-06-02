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
 * options / popup 下拉与 chips 用的常用目标语言。code 是传给 translate() 的 BCP-47，
 * label 用于显示（用各语言本地写法或中文名，跟设计稿一致）。zh 拆成 zh-Hans / zh-Hant，
 * Chrome Translator 的目标语言需要这种细分（'zh' 不够明确）。
 */
export const TARGET_LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'zh-Hans', label: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'it', label: '意大利语' },
  { code: 'pt', label: '葡萄牙语' },
  { code: 'vi', label: '越南语' },
  { code: 'th', label: '泰语' },
  { code: 'ar', label: '阿拉伯语' },
];

/** 源语言下拉：「自动识别」+ 同一组语言。'auto' 走自动检测。 */
export const SOURCE_LANGUAGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'auto', label: '自动识别' },
  ...TARGET_LANGUAGE_OPTIONS,
];

/** 目标语言区下方「常用目标」chips 展示哪几个（设计稿 ③ 那一排）。 */
export const COMMON_TARGET_CODES: ReadonlyArray<string> = ['zh-Hans', 'en', 'ja', 'ko', 'zh-Hant'];

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
