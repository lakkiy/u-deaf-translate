// Chrome 内置 AI 后端：Translator（翻译）+ LanguageDetector（语言检测）。零联网；Chrome 138+ 桌面版。
// 这两个 API 不支持 Web Worker、移动端；首次某语言对会下载几十 MB 模型。
//
// 本文件还负责实例的生命周期：Chrome 按 alive 实例数限额，必须显式 destroy（见文件末尾）。

import { getLanguageDisplayName } from '../languages';

// 这些 API 还很新，TypeScript 的内置 lib 和 @types/chrome 都还没有完整类型，
// 这里手动声明最小可用的类型。
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

const CREATE_TIMEOUT_MS = 60_000;
const FAILED_RETRY_COOLDOWN_MS = 3_000;
const CONFIDENCE_THRESHOLD = 0.5;
const TIMEOUT_SENTINEL = '__tnyl_timeout__';

// ── 语言检测 ───────────────────────────────────────────────

export interface DetectResult {
  language: string;
  /** 语言检测置信度低或返回 "und" 时为 true（此时按英语兜底） */
  uncertain: boolean;
}

// 单例 LanguageDetector，整个页面共用
let detectorPromise: Promise<LanguageDetectorInstance> | null = null;

function getDetector(): Promise<LanguageDetectorInstance> {
  if (!detectorPromise) {
    const p = LanguageDetector.create();
    p.then((d) => { liveDetector = d; }, () => {});
    detectorPromise = p;
  }
  return detectorPromise;
}

export async function detectLanguage(text: string): Promise<DetectResult> {
  // LanguageDetector 不可用时的兜底（LLM 后端用户的浏览器可能没有 Chrome 内置 AI）：
  // 含汉字按中文，否则按英语。只够 pickTargetLanguage 二选一（译中 / 译英），不追求精确——
  // 精确检测本来就依赖那个缺席的 API。
  if (typeof LanguageDetector === 'undefined') {
    return { language: /[一-鿿]/.test(text) ? 'zh' : 'en', uncertain: true };
  }
  const detector = await getDetector();
  const results = await detector.detect(text);
  const top = results[0];
  if (!top || top.detectedLanguage === 'und' || top.confidence < CONFIDENCE_THRESHOLD) {
    return { language: 'en', uncertain: true };
  }
  return { language: top.detectedLanguage, uncertain: false };
}

// ── 翻译 ───────────────────────────────────────────────────

// 每个「源语言:目标语言」对应一个 Translator。
// 存的是 Promise（而不是已解析的实例），这样并发请求会共享同一次模型下载。
const translatorPromises = new Map<string, Promise<TranslatorInstance>>();

// 创建成功过的语言对。Chrome Translator API 在 service count 超限时
// 抛 NotSupportedError，跟"真不支持"用同一个错误。靠这个集合区分：
// 此 pair 之前成功过、现在失败 → 是限速而不是不支持。
const successfulPairs = new Set<string>();

function getTranslator(sourceLanguage: string, targetLanguage: string): Promise<TranslatorInstance> {
  const key = `${sourceLanguage}:${targetLanguage}`;
  const cached = translatorPromises.get(key);
  if (cached) return cached;

  const promise = createTranslator(sourceLanguage, targetLanguage, key);
  // 失败时延迟 3 秒再清出缓存。这 3 秒内的重试共享同一个被拒 promise，
  // 不会反复触发 Translator.create()——避免限速状态下连点把 count 推得更高。
  promise.catch(() => {
    setTimeout(() => translatorPromises.delete(key), FAILED_RETRY_COOLDOWN_MS);
  });
  translatorPromises.set(key, promise);
  return promise;
}

async function createTranslator(
  sourceLanguage: string,
  targetLanguage: string,
  key: string,
): Promise<TranslatorInstance> {
  if (typeof Translator === 'undefined') {
    throw new Error('Chrome 内置翻译不可用（需要 Chrome 138+ 桌面版），可在设置里换用其他翻译服务');
  }

  const createPromise = Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        const progress = (event as DownloadProgressEvent).loaded;
        if (progress >= 1) return; // 模型已缓存时 Chrome 仍会触发 progress=1，过滤
        console.log(`[叫你翻译你聋吗] 下载翻译模型: ${Math.round(progress * 100)}%`);
      });
    },
  });

  // 某些不支持的语言对可能让 create() 永远卡住，加一个 60s 兜底
  const timeoutPromise = new Promise<TranslatorInstance>((_, reject) => {
    setTimeout(() => reject(new Error(TIMEOUT_SENTINEL)), CREATE_TIMEOUT_MS);
  });

  try {
    const instance = await Promise.race([createPromise, timeoutPromise]);
    successfulPairs.add(key);
    liveTranslators.add(instance);
    return instance;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[叫你翻译你聋吗] Translator.create 失败:', err);
    const pairName = `${getLanguageDisplayName(sourceLanguage)} → ${getLanguageDisplayName(targetLanguage)}`;
    if (msg === TIMEOUT_SENTINEL) {
      throw new Error(`翻译模型加载超时（60s）：${pairName}`);
    }
    // 同一 content script 实例里之前成功过 → 必然是被限速
    if (successfulPairs.has(key)) {
      throw new Error(`Chrome 翻译次数超限，稍等几分钟或重启浏览器再试`);
    }
    // 否则无法可靠区分"真不支持"和"跨页累积限速"——Translator.availability()
    // 在限速时对所有语言对都返回 'unavailable'，根本帮不上忙。给一条诚实的双因消息。
    throw new Error(
      `${pairName} 翻译失败：可能 Chrome 限制了使用次数，或该语言对不支持。稍后重试或重启浏览器。`,
    );
  }
}

/** Chrome Translator.translate() 抛出的英文错误映射成可读中文，原始错误保留在 console.error。 */
function friendlyTranslateError(rawMessage: string, sourceLanguage: string): string {
  // "Other generic failures occurred." —— Chrome 对极短/无意义输入（"Thu" / 日期 / 单符号）的兜底
  if (/other generic failures/i.test(rawMessage)) {
    return `无法翻译这段文本（可能太短或不是有效的${getLanguageDisplayName(sourceLanguage)}内容）`;
  }
  if (/not available|unavailable/i.test(rawMessage)) {
    return `翻译服务暂不可用，稍后重试`;
  }
  return `翻译失败：${rawMessage}`;
}

export async function translateViaChrome(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  const translator = await getTranslator(sourceLanguage, targetLanguage);

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

// ── 实例销毁 ───────────────────────────────────────────────

// Chrome 的 service count 配额按 alive 实例数算，不是按调用次数。JS 端的引用
// 被 GC 掉不会自动减少 Chrome 内部计数——必须显式调 destroy()，否则用户连续浏览
// 多个页面后会累积到上限，所有翻译失败。这两个变量保存当前 alive 的实例引用。
const liveTranslators = new Set<TranslatorInstance>();
let liveDetector: LanguageDetectorInstance | null = null;

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
