import type { Chunk } from '../../shared/types';

const ABBREVS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'i.e', 'e.g', 'fig', 'eq', 'ref', 'st']);

export function cleanText(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function innerTextClean(el: Element): string {
  return cleanText((el as HTMLElement).innerText || el.textContent || '');
}

export function chunkText(text: string, doc: Document): Chunk[] {
  const paragraphs = cleanText(text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphId = ensureParagraphMarker(doc, paragraph, paragraphIndex);
    const sentences = splitSentences(paragraph);
    for (const sentence of sentences) {
      chunks.push({ index: chunks.length, text: sentence, paragraphId });
    }
  });

  if (!chunks.length && text.trim()) {
    chunks.push({ index: 0, text: cleanText(text), paragraphId: ensureParagraphMarker(doc, text, 0) });
  }

  return chunks;
}

export function splitSentences(text: string): string[] {
  const rawSentences: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1] ?? '';
    if (!'.!?'.includes(char) || !/\s/.test(next)) continue;
    if (isDecimal(text, i) || isAbbrev(text, i)) continue;

    const sentence = text.slice(start, i + 1).trim();
    if (sentence) rawSentences.push(sentence);
    start = i + 1;
  }

  const tail = text.slice(start).trim();
  if (tail) rawSentences.push(tail);

  const sentences = rawSentences.length ? rawSentences : [text];
  return sentences.flatMap(splitLongSentence).filter((sentence) => sentence.length > 5);
}

function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= 150) return [sentence];

  const result: string[] = [];
  const parts = sentence.split(/[,;]\s+/);
  let current = '';

  for (const part of parts) {
    const candidate = current ? `${current}, ${part}` : part;
    if (candidate.length <= 150) {
      current = candidate;
    } else {
      if (current) result.push(current);
      current = part;
    }
  }

  if (current) result.push(current);
  return result.flatMap((part) => part.length <= 150 ? [part] : splitByWords(part));
}

function splitByWords(text: string): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= 150) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function isDecimal(text: string, dotIndex: number): boolean {
  return /\d/.test(text[dotIndex - 1] ?? '') && /\d/.test(text[dotIndex + 1] ?? '');
}

function isAbbrev(text: string, dotIndex: number): boolean {
  const before = text.slice(Math.max(0, dotIndex - 12), dotIndex).toLowerCase();
  const match = before.match(/([a-z](?:\.?[a-z])*)$/);
  return !!match && ABBREVS.has(match[1]);
}

function ensureParagraphMarker(doc: Document, paragraph: string, index: number): string {
  const existing = `ra-${Date.now().toString(36)}-${index}`;
  const needle = cleanText(paragraph).slice(0, 80);
  const candidates = [...doc.querySelectorAll('p, li, blockquote, h1, h2, h3, article, main, [role="main"]')] as HTMLElement[];
  const match = candidates.find((el) => innerTextClean(el).includes(needle));
  const el = match ?? doc.body;
  if (!el.dataset.readaloudId) el.dataset.readaloudId = existing;
  return el.dataset.readaloudId;
}
