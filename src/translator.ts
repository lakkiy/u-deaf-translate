// Chrome 内置 Translator / LanguageDetector 的封装。
// 这两个 API 在 Chrome 138+ 桌面端默认可用，不需要任何 manifest 权限。
//   - 首次使用某个语言对时会下载语言模型（几十 MB），后续可离线使用
//   - 不支持移动端、不支持 Web Worker

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

const TARGET_LANGUAGE = 'zh-Hans';
const TRANSLATE_TIMEOUT_MS = 60_000;
const CONFIDENCE_THRESHOLD = 0.5;

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

export async function detectLanguage(text: string): Promise<DetectResult> {
  const detector = await getDetector();
  const results = await detector.detect(text);
  const top = results[0];
  if (!top || top.detectedLanguage === 'und' || top.confidence < CONFIDENCE_THRESHOLD) {
    return { language: 'en', uncertain: true };
  }
  return { language: top.detectedLanguage, uncertain: false };
}

function getTranslator(
  sourceLanguage: string,
  onProgress?: DownloadProgressHandler,
): Promise<TranslatorInstance> {
  const key = `${sourceLanguage}:${TARGET_LANGUAGE}`;
  const cached = translatorPromises.get(key);
  if (cached) return cached;

  const promise = createTranslator(sourceLanguage, onProgress);
  // 失败时移出缓存，允许下次重试
  promise.catch(() => translatorPromises.delete(key));
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
  onProgress?: DownloadProgressHandler,
): Promise<TranslatorInstance> {
  const createPromise = Translator.create({
    sourceLanguage,
    targetLanguage: TARGET_LANGUAGE,
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

  const key = `${sourceLanguage}:${TARGET_LANGUAGE}`;

  try {
    const instance = await Promise.race([createPromise, timeoutPromise]);
    successfulPairs.add(key);
    liveTranslators.add(instance);
    return instance;
  } catch (err) {
    const langName = getLanguageName(sourceLanguage);
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[叫你翻译你聋吗] Translator.create 失败:', err);
    if (msg === TIMEOUT_SENTINEL) {
      throw new Error(`翻译模型加载超时（60s）：${langName} → 简体中文`);
    }
    // 同一 content script 实例里之前成功过 → 必然是被限速
    if (successfulPairs.has(key)) {
      throw new Error(`Chrome 翻译次数超限，稍等几分钟或重启浏览器再试`);
    }
    // 否则无法可靠区分"真不支持"和"跨页累积限速"——Translator.availability()
    // 在限速时对所有语言对都返回 'unavailable'，根本帮不上忙。给一条诚实的双因消息。
    throw new Error(
      `「${langName}」翻译失败：可能 Chrome 限制了使用次数，或该语言对不支持。稍后重试或重启浏览器。`,
    );
  }
}

export async function translate(
  text: string,
  sourceLanguage: string,
  onProgress?: DownloadProgressHandler,
): Promise<string> {
  if (sourceLanguage === TARGET_LANGUAGE) return text;
  const translator = await getTranslator(sourceLanguage, onProgress);

  // 按换行符切分，逐段翻译再拼回去。整段直接传给 Translator 会让段落被压平成一行。
  // split 用 capturing group，分隔符（\n+）也会被保留在结果数组里，方便原样拼回。
  const parts = text.split(/(\n+)/);
  const out: string[] = [];
  for (const part of parts) {
    out.push(part.trim() ? await translator.translate(part) : part);
  }
  return out.join('');
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
