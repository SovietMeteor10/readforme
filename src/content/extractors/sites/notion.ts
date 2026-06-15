import { cleanText } from '../text';

export function extractNotion(doc: Document): string {
  const root = doc.querySelector('.notion-page-content, [data-block-id]');
  if (!root) return '';
  const blocks = [...doc.querySelectorAll('[data-block-id]')]
    .map((el) => cleanText(el.textContent ?? ''))
    .filter(Boolean);
  return cleanText(blocks.length ? blocks.join('\n\n') : root.textContent ?? '');
}
