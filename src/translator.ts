// 翻译入口模块。两个后端可选：
//   1. Chrome 内置 Translator / LanguageDetector（默认；零联网；Chrome 138+）
//   2. 自定义 LLM endpoint（OpenAI 兼容；用户在 options 页面配置）
// translate() 根据配置 dispatch；上层（content.ts / page-translator.ts）不感知。
//
// Chrome 这两个 API 不支持 Web Worker、移动端；首次某语言对会下载几十 MB 模型。

// 这些 API 还很新，TypeScript 的内置 lib 和 @types/chrome 都还没有完整类型，
// 这里手动声明最小可用的类型。
import { getConfig } from './config';
import { DEEPSEEK_ENDPOINT } from './deepseek';
import { translateViaLlm } from './llm-backend';

declare global {
  const Translator: TranslatorFactory;
  const LanguageDetector: LanguageDetectorFactory;

  interface TranslatorFactory {
    create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
  }
  interface TranslatorCreateOptions {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }
  interface TranslatorInstance {
    translate(text: string): Promise<string>;
    destroy(): void;
  }

  interface LanguageDetectorFactory {
    create(): Promise<LanguageDetectorInstance>;
  }
  interface LanguageDetectorInstance {
    detect(text: string): Promise<DetectionResult[]>;
    destroy(): void;
  }
  interface DetectionResult {
    detectedLanguage: string;
    confidence: number;
  }
  interface DownloadProgressEvent extends Event {
    loaded: number; // 0..1
  }
}

const TRANSLATE_TIMEOUT_MS = 60_000;
const CONFIDENCE_THRESHOLD = 0.5;

/** BCP-47 主子标签比较：`zh-Hans` / `zh-CN` / `zh-TW` 都算同一语族。 */
function sameLanguageFamily(a: string, b: string): boolean {
  return a.split('-')[0] === b.split('-')[0];
}

// 智能反向：源与目标同族时翻向「另一边」。回译语言取英语；若目标本身就是英语族，则回译中文。
// 保留这套行为（用户反馈：选中文要能得到英文、选英文要能得到中文），目标语言改由 config 配置。
function reverseTarget(primaryTarget: string): string {
  return sameLanguageFamily(primaryTarget, 'en') ? 'zh-Hans' : 'en';
}

// 选中文本与配置的目标语言同族 → 翻向回译语言；否则 → 翻向配置的目标语言。
function pickTargetLanguage(sourceLanguage: string, primaryTarget: string): string {
  return sameLanguageFamily(sourceLanguage, primaryTarget)
    ? reverseTarget(primaryTarget)
    : primaryTarget;
}

export interface DetectResult {
  language: string;
  /** 语言检测置信度低或返回 "und" 时为 true（此时按英语兜底） */
  uncertain: boolean;
}

export type DownloadProgressHandler = (progress: number) => void;

export function isApiAvailable(): boolean {
  return typeof Translator !== 'undefined' && typeof LanguageDetector !== 'undefined';
}

// 单例 LanguageDetector，整个页面共用
let detectorPromise: Promise<LanguageDetectorInstance> | null = null;

// 每个 "源语言 → zh-Hans" 对应一个 Translator。
// 存的是 Promise（而不是已解析的实例），这样并发请求会共享同一次模型下载。
const translatorPromises = new Map<string, Promise<TranslatorInstance>>();

// 创建成功过的语言对。Chrome Translator API 在 service count 超限时
// 抛 NotSupportedError，跟"真不支持"用同一个错误。靠这个集合区分：
// 此 pair 之前成功过、现在失败 → 是限速而不是不支持。
const successfulPairs = new Set<string>();

// Chrome 的 service count 配额按 alive 实例数算，不是按调用次数。JS 端的引用
// 被 GC 掉不会自动减少 Chrome 内部计数——必须显式调 destroy()。这两个变量
// 保存当前 alive 的实例引用，便于 pagehide 时同步 destroy。
const liveTranslators = new Set<TranslatorInstance>();
let liveDetector: LanguageDetectorInstance | null = null;

function getDetector(): Promise<LanguageDetectorInstance> {
  if (!detectorPromise) {
    const p = LanguageDetector.create();
    p.then((d) => { liveDetector = d; }, () => {});
    detectorPromise = p;
  }
  return detectorPromise;
}

/**
 * LanguageDetector 不可用时的兜底（LLM 后端用户的浏览器可能没有 Chrome 内置 AI）：
 * 含汉字按中文，否则按英语。只够 pickTargetLanguage 二选一（译中 / 译英），不追求精确——
 * 精确检测本来就依赖那个缺席的 API。
 */
function detectByHeuristic(text: string): DetectResult {
  return { language: /[一-鿿]/.test(text) ? 'zh' : 'en', uncertain: true };
}

export async function detectLanguage(text: string): Promise<DetectResult> {
  if (typeof LanguageDetector === 'undefined') return detectByHeuristic(text);
  const detector = await getDetector();
  const results = await detector.detect(text);
  const top = results[0];
  if (!top || top.detectedLanguage === 'und' || top.confidence < CONFIDENCE_THRESHOLD) {
    return { language: 'en', uncertain: true };
  }
  return { language: top.detectedLanguage, uncertain: false };
}

/**
 * 解析源语言：config.sourceLanguage 非 'auto' 时直接用用户指定的源语言（跳过检测）；
 * 否则走 detectLanguage 自动检测。划词与整页两条路径共用，保证手动指定源语言能生效。
 */
export async function resolveSourceLanguage(text: string): Promise<DetectResult> {
  const cfg = await getConfig();
  if (cfg.sourceLanguage && cfg.sourceLanguage !== 'auto') {
    return { language: cfg.sourceLanguage, uncertain: false };
  }
  return detectLanguage(text);
}

const FAILED_RETRY_COOLDOWN_MS = 3_000;

function getTranslator(
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?: DownloadProgressHandler,
): Promise<TranslatorInstance> {
  const key = `${sourceLanguage}:${targetLanguage}`;
  const cached = translatorPromises.get(key);
  if (cached) return cached;

  const promise = createTranslator(sourceLanguage, targetLanguage, onProgress);
  // 失败时延迟 3 秒再清出缓存。这 3 秒内的重试共享同一个被拒 promise，
  // 不会反复触发 Translator.create()——避免限速状态下连点把 count 推得更高。
  promise.catch(() => {
    setTimeout(() => translatorPromises.delete(key), FAILED_RETRY_COOLDOWN_MS);
  });
  translatorPromises.set(key, promise);
  return promise;
}

/** 把 BCP 47 语言代码转成中文名（如 'is' → '冰岛语'）。 */
function getLanguageName(code: string): string {
  try {
    return new Intl.DisplayNames(['zh-Hans'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const TIMEOUT_SENTINEL = '__tnyl_timeout__';

async function createTranslator(
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?: DownloadProgressHandler,
): Promise<TranslatorInstance> {
  const createPromise = Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        onProgress?.((event as DownloadProgressEvent).loaded);
      });
    },
  });

  // 某些不支持的语言对可能让 create() 永远卡住，加一个 60s 兜底
  const timeoutPromise = new Promise<TranslatorInstance>((_, reject) => {
    setTimeout(() => reject(new Error(TIMEOUT_SENTINEL)), TRANSLATE_TIMEOUT_MS);
  });

  const key = `${sourceLanguage}:${targetLanguage}`;
  const sourceName = getLanguageName(sourceLanguage);
  const targetName = getLanguageName(targetLanguage);

  try {
    const instance = await Promise.race([createPromise, timeoutPromise]);
    successfulPairs.add(key);
    liveTranslators.add(instance);
    return instance;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[叫你翻译你聋吗] Translator.create 失败:', err);
    if (msg === TIMEOUT_SENTINEL) {
      throw new Error(`翻译模型加载超时（60s）：${sourceName} → ${targetName}`);
    }
    // 同一 content script 实例里之前成功过 → 必然是被限速
    if (successfulPairs.has(key)) {
      throw new Error(`Chrome 翻译次数超限，稍等几分钟或重启浏览器再试`);
    }
    // 否则无法可靠区分"真不支持"和"跨页累积限速"——Translator.availability()
    // 在限速时对所有语言对都返回 'unavailable'，根本帮不上忙。给一条诚实的双因消息。
    throw new Error(
      `${sourceName} → ${targetName} 翻译失败：可能 Chrome 限制了使用次数，或该语言对不支持。稍后重试或重启浏览器。`,
    );
  }
}

/** Chrome Translator.translate() 抛出的英文错误映射成可读中文，原始错误保留在 console.error。 */
function friendlyTranslateError(rawMessage: string, sourceLanguage: string): string {
  const langName = getLanguageName(sourceLanguage);
  // "Other generic failures occurred." —— Chrome 对极短/无意义输入（"Thu" / 日期 / 单符号）的兜底
  if (/other generic failures/i.test(rawMessage)) {
    return `无法翻译这段文本（可能太短或不是有效的${langName}内容）`;
  }
  if (/not available|unavailable/i.test(rawMessage)) {
    return `翻译服务暂不可用，稍后重试`;
  }
  return `翻译失败：${rawMessage}`;
}

async function translateViaChrome(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?: DownloadProgressHandler,
): Promise<string> {
  const translator = await getTranslator(sourceLanguage, targetLanguage, onProgress);

  // 按换行符切分，逐段翻译再拼回去。整段直接传给 Translator 会让段落被压平成一行。
  // split 用 capturing group，分隔符（\n+）也会被保留在结果数组里，方便原样拼回。
  const parts = text.split(/(\n+)/);
  const out: string[] = [];
  for (const part of parts) {
    if (!part.trim()) {
      out.push(part);
      continue;
    }
    try {
      out.push(await translator.translate(part));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[叫你翻译你聋吗] Translator.translate 失败:', err, '文本片段:', part.slice(0, 80));
      throw new Error(friendlyTranslateError(msg, sourceLanguage));
    }
  }
  return out.join('');
}

/**
 * 翻译入口。根据 config.active 三选一 dispatch（chrome / deepseek / custom）。
 * onProgress 只对 Chrome 后端有意义（模型下载进度），LLM 后端不触发。
 */
export async function translate(
  text: string,
  sourceLanguage: string,
  onProgress?: DownloadProgressHandler,
): Promise<string> {
  const cfg = await getConfig();
  // 目标语言取配置值；pickTargetLanguage 保证源与目标不同族（同族走智能反向），无需再判同族跳过。
  const targetLanguage = pickTargetLanguage(sourceLanguage, cfg.targetLanguage);

  switch (cfg.active) {
    case 'chrome':
      return translateViaChrome(text, sourceLanguage, targetLanguage, onProgress);
    case 'deepseek':
      // DeepSeek endpoint 内置；apiKey/model/system/prompt/参数来自用户配置
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

/**
 * 页面卸载时同步销毁所有 alive 的 Translator / LanguageDetector 实例，
 * 释放 Chrome 内部的 service count 配额。
 *
 * 关键：JS 引用被 GC 不会自动减少 Chrome 计数器——必须显式 destroy()。
 * 不这么做的话，用户连续浏览多个页面后 Chrome 会累积到上限，所有翻译失败。
 */
function destroyAll(): void {
  for (const t of liveTranslators) {
    try { t.destroy(); } catch { /* ignore */ }
  }
  liveTranslators.clear();
  translatorPromises.clear();
  successfulPairs.clear();

  if (liveDetector) {
    try { liveDetector.destroy(); } catch { /* ignore */ }
    liveDetector = null;
  }
  detectorPromise = null;
}

// pagehide 在页面真正卸载/导航前最后一次回调，是销毁实例的最佳时机。
// 不用 beforeunload：现代浏览器对它态度暧昧，且在 BFCache 场景会被跳过。
window.addEventListener('pagehide', destroyAll);

// 多 tab 场景下，切走 tab 时 pagehide 不会触发，但本 tab 持有的实例
// 仍然占 Chrome 全局 service count 配额——会卡住别的 tab 的翻译。
// visibilitychange 切到 hidden 时也释放；切回来时下一次翻译会重新 create。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') destroyAll();
});
