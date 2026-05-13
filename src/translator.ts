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
    /** 探查某语言对是否可用——比 create 失败时反向推断更可靠 */
    availability?(options: TranslatorAvailabilityOptions): Promise<TranslatorAvailability>;
  }
  interface TranslatorCreateOptions {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }
  interface TranslatorAvailabilityOptions {
    sourceLanguage: string;
    targetLanguage: string;
  }
  type TranslatorAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
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

export const TARGET_LANGUAGE = 'zh-Hans';
const TRANSLATE_TIMEOUT_MS = 60_000;
const CONFIDENCE_THRESHOLD = 0.5;

export interface DetectResult {
  language: string;
  confidence: number;
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

// 创建成功过的语言对。Chrome Translator API 在触发"service count exceeded"
// 速率限制时会抛 NotSupportedError，跟"真不支持"用同一个错误。靠这个集合
// 区分：如果此 pair 之前成功过、现在失败，大概率是被限速而不是不支持。
// 仅内存，刷新页面会丢——能容忍。
const successfulPairs = new Set<string>();

function getDetector(): Promise<LanguageDetectorInstance> {
  if (!detectorPromise) {
    detectorPromise = LanguageDetector.create();
  }
  return detectorPromise;
}

export async function detectLanguage(text: string): Promise<DetectResult> {
  const detector = await getDetector();
  const results = await detector.detect(text);
  const top = results[0];
  if (!top || top.detectedLanguage === 'und' || top.confidence < CONFIDENCE_THRESHOLD) {
    return { language: 'en', confidence: top?.confidence ?? 0, uncertain: true };
  }
  return { language: top.detectedLanguage, confidence: top.confidence, uncertain: false };
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
    // 否则可能是"真不支持"或"跨页累积限速"（新页面的 successfulPairs 是空的）。
    // 探查 availability() 区分：明确 'unavailable' = 真不支持；其他状态 = 支持但 create 失败
    const supported = await checkPairAvailability(sourceLanguage, TARGET_LANGUAGE);
    if (supported === false) {
      throw new Error(`暂不支持「${langName}」翻译为简体中文`);
    }
    // supported === true（语言对存在）或 null（availability 方法不可用 / 自身也被限速）
    throw new Error(
      `「${langName}」翻译失败：可能 Chrome 限制了使用次数，或该语言对不支持。稍后重试或重启浏览器。`,
    );
  }
}

/**
 * 查询某语言对的可用性。
 * - 返回 true：明确支持（available/downloadable/downloading 任一）
 * - 返回 false：明确不支持（unavailable）
 * - 返回 null：方法不存在或调用失败（无法判断）
 */
async function checkPairAvailability(
  source: string,
  target: string,
): Promise<boolean | null> {
  if (typeof Translator.availability !== 'function') return null;
  try {
    const status = await Translator.availability({
      sourceLanguage: source,
      targetLanguage: target,
    });
    return status === 'unavailable' ? false : true;
  } catch {
    return null;
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
