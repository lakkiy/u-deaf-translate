import { parseHTML } from 'linkedom';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
// 静态相对 import 是安全的：page-content.ts 模块顶层不碰 document，
// 只有 findContentRoot/collectParagraphs 被调用时才读 globalThis.document。
import { findContentRoot, collectParagraphs, paragraphText } from '../src/page-content';

const PAGES_DIR = join(import.meta.dir, 'pages');
const RESULTS_DIR = join(import.meta.dir, 'results');

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function classList(el: Element): string {
  const cls = el.getAttribute('class') ?? '';
  return cls.split(/\s+/).filter(Boolean).slice(0, 5).join('.');
}

function evalOne(filePath: string): void {
  const html = readFileSync(filePath, 'utf-8');
  const { document, Element, Node } = parseHTML(html);

  // @ts-ignore
  globalThis.document = document;
  // @ts-ignore
  globalThis.Element = Element;
  // @ts-ignore
  globalThis.Node = Node;

  const root = findContentRoot();
  const paragraphs = collectParagraphs(root);

  const lines: string[] = [];
  lines.push(`Root descriptor: <${root.tagName.toLowerCase()}> id="${root.getAttribute('id') ?? ''}" class="${classList(root)}"`);
  lines.push(`Total candidate paragraph count: ${paragraphs.length}`);
  lines.push('');
  lines.push('--- Paragraphs ---');
  paragraphs.forEach((el: Element, i: number) => {
    const text = collapse(paragraphText(el) ?? '').slice(0, 80);
    lines.push(`${i + 1}. [${el.tagName.toLowerCase()}] ${text}`);
  });

  const name = basename(filePath, extname(filePath));
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${name}.txt`), lines.join('\n') + '\n');
  console.log(`Wrote eval/results/${name}.txt (${paragraphs.length} paragraphs, root=<${root.tagName.toLowerCase()}>)`);
}

const arg = process.argv[2];
const targets = arg
  ? [arg]
  : readdirSync(PAGES_DIR)
      .filter((f) => f.endsWith('.html'))
      .sort()
      .map((f) => join(PAGES_DIR, f));

for (const filePath of targets) {
  evalOne(filePath);
}
