import type { Chunk } from '../../shared/types';
import { GOOD_TEXT_LENGTH } from '../../shared/constants';
import { extractReadability } from './readability';
import { chunkText, cleanText as cleanPlainText, innerTextClean } from './text';
import { extractArxiv } from './sites/arxiv';
import { extractSubstack } from './sites/substack';
import { extractNotion } from './sites/notion';
import { extractGoogleDocs } from './sites/google-docs';
import { extractMedium } from './sites/medium';
import { extractGithub } from './sites/github';

type SiteExtractor = (doc: Document) => string;

export async function extractContent(doc: Document): Promise<Chunk[]> {
  if (doc.location.href.toLowerCase().endsWith('.pdf')) {
    throw new Error('Chrome blocks direct PDF text access. Open PDFs outside Chrome PDF Viewer, then try OCR.');
  }

  const siteExtractor = getSiteExtractor(doc.location.hostname);
  if (siteExtractor) {
    const siteText = siteExtractor(doc);
    if (siteText.length > GOOD_TEXT_LENGTH) return chunkText(siteText, doc);
  }

  const articleChunks = extractArticleChunks(doc);
  if (articleChunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > GOOD_TEXT_LENGTH) return articleChunks;

  const readable = extractReadability(doc);
  if (readable.length > GOOD_TEXT_LENGTH) return chunkText(readable, doc);

  const semantic = extractSemantic(doc);
  if (semantic.length > GOOD_TEXT_LENGTH) return chunkText(semantic, doc);

  return chunkText(extractSemantic(doc) || '', doc);
}

function getSiteExtractor(hostname: string): SiteExtractor | null {
  if (hostname.includes('arxiv.org')) return extractArxiv;
  if (hostname.includes('substack.com')) return extractSubstack;
  if (hostname.includes('notion.site') || hostname.includes('notion.so')) return extractNotion;
  if (hostname.includes('docs.google.com')) return extractGoogleDocs;
  if (hostname.includes('medium.com')) return extractMedium;
  if (hostname.includes('github.com')) return extractGithub;
  return null;
}

function extractSemantic(doc: Document): string {
  const selectors = [
    'article',
    '[role="main"]',
    'main',
    '.post-content',
    '.article-content',
    '.entry-content',
    '.content',
    '#content',
    '.story-body',
    '.article-body'
  ];

  for (const selector of selectors) {
    const el = queryShadow(doc, selector)[0];
    if (el) {
      const text = innerTextClean(el);
      if (text.length > GOOD_TEXT_LENGTH) return text;
    }
  }

  const body = doc.body.cloneNode(true) as HTMLElement;
  [
    'nav',
    'header',
    'footer',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="complementary"]',
    '.sidebar',
    '.nav',
    '.menu',
    '.header',
    '.footer',
    '.cookie-banner',
    '.cookie-notice',
    '.gdpr',
    '.ad',
    '.advertisement',
    '.sponsored',
    '.related-articles',
    '.recommended',
    '.more-stories',
    'script',
    'style',
    'noscript',
    'iframe'
  ].forEach((selector) => body.querySelectorAll(selector).forEach((el) => el.remove()));

  return cleanPlainText(body.textContent ?? '');
}

function cleanText(text: string): string {
  return cleanPlainText(text)
    .replace(/\[(?:\d+|nb \d+|note \d+|edit|citation needed|[a-z])\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isReadableElement(el: Element): boolean {
  const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'FIGURE', 'FIGCAPTION', 'TABLE', 'MATH', 'SUP', 'SUB'];
  if (skipTags.includes(el.tagName)) return false;

  const skipPatterns = [
    'reflist',
    'references',
    'footnote',
    'citation',
    'navbox',
    'navigation',
    'sidebar',
    'infobox',
    'wikitable',
    'hatnote',
    'thumb',
    'gallery',
    'toc',
    'mw-editsection',
    'catlinks',
    'mw-references',
    'external',
    'printfooter',
    'noprint',
    'mw-jump-link',
    'language-links',
    'metadata',
    'ambox'
  ];

  const className = typeof el.className === 'string' ? el.className : '';
  const marker = `${className} ${el.id}`.toLowerCase();
  if (skipPatterns.some((pattern) => marker.includes(pattern))) return false;

  const text = getCleanText(el);
  if (text.length < 15) return false;

  const alphaRatio = (text.match(/[a-zA-Z]/g) ?? []).length / text.length;
  return alphaRatio >= 0.5;
}

export function extractArticleChunks(doc: Document): Chunk[] {
  const articleBody =
    doc.querySelector('#mw-content-text .mw-parser-output') ||
    doc.querySelector('article') ||
    doc.querySelector('[role="main"]') ||
    doc.body;

  const elements: Element[] = [];
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  collectReadable(articleBody, elements);

  elements.forEach((el, elIndex) => {
    const text = getCleanText(el);
    if (text.length < 20) return;

    const paragraphId = `ra-${elIndex}`;
    if (el instanceof HTMLElement) {
      el.dataset.readaloudId = paragraphId;
      el.setAttribute('data-readaloud-id', paragraphId);
    }

    const paragraphChunks = chunkParagraphText(text, paragraphId, chunkIndex);
    chunks.push(...paragraphChunks);
    chunkIndex += paragraphChunks.length;
  });

  return chunks;
}

function chunkParagraphText(text: string, paragraphId: string, startIndex: number): Chunk[] {
  if (text.length <= 1_500) return [{ index: startIndex, text, paragraphId }];

  const splitAt = findSentenceBoundaryNear(text, Math.floor(text.length / 2));
  const first = text.slice(0, splitAt).trim();
  const second = text.slice(splitAt).trim();
  const chunks: Chunk[] = [];

  if (first.length >= 20) chunks.push({ index: startIndex + chunks.length, text: first, paragraphId });
  if (second.length >= 20) chunks.push({ index: startIndex + chunks.length, text: second, paragraphId });

  return chunks.length ? chunks : [{ index: startIndex, text, paragraphId }];
}

function findSentenceBoundaryNear(text: string, pos: number): number {
  for (let i = pos; i < Math.min(pos + 100, text.length - 2); i += 1) {
    if (text[i] === '.' && text[i + 1] === ' ' && text[i + 2] === text[i + 2].toUpperCase()) {
      return i + 2;
    }
  }

  for (let i = pos; i > Math.max(pos - 100, 0); i -= 1) {
    if (text[i] === '.' && text[i + 1] === ' ') return i + 2;
  }

  const wordBoundary = text.lastIndexOf(' ', pos);
  return wordBoundary > 20 ? wordBoundary + 1 : pos;
}

function getCleanText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll([
    'sup',
    '.reference',
    '.mw-editsection',
    '.noprint',
    '.metadata',
    '[style*="display:none"]',
    '[style*="display: none"]',
    'style',
    'script'
  ].join(', ')).forEach((node) => node.remove());

  return (clone.textContent ?? '')
    .replace(/\[\d+\]/g, '')
    .replace(/\[nb \d+\]/gi, '')
    .replace(/\[note \d+\]/gi, '')
    .replace(/\[edit\]/gi, '')
    .replace(/\[show\]/gi, '')
    .replace(/\[hide\]/gi, '')
    .replace(/\[[a-z]\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectReadable(root: Element, elements: Element[], depth = 0) {
  for (const child of Array.from(root.children)) {
    const tag = child.tagName;
    const className = typeof child.className === 'string' ? child.className.toLowerCase() : '';
    const id = child.id.toLowerCase();
    const marker = `${className} ${id}`;

    if (
      tag === 'TABLE' ||
      tag === 'FIGURE' ||
      tag === 'MATH' ||
      tag === 'STYLE' ||
      tag === 'SCRIPT' ||
      [
        'infobox',
        'navbox',
        'sidebar',
        'reflist',
        'references',
        'mw-references',
        'toc',
        'thumb',
        'gallery',
        'hatnote',
        'noprint',
        'mw-empty-elt',
        'catlinks',
        'printfooter',
        'mw-cite',
        'footnotes',
        'external-links',
        'see-also'
      ].some((pattern) => marker.includes(pattern))
    ) {
      continue;
    }

    if (['H1', 'H2', 'H3', 'H4', 'P', 'LI'].includes(tag)) {
      if (isReadableElement(child)) elements.push(child);
    } else if (depth < 3) {
      collectReadable(child, elements, depth + 1);
    }
  }
}

function queryShadow(root: Document | ShadowRoot, selector: string): Element[] {
  const results = [...root.querySelectorAll(selector)];
  root.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) results.push(...queryShadow(el.shadowRoot, selector));
  });
  return results;
}
