import { cleanText } from '../text';

export function extractMedium(doc: Document): string {
  const article = doc.querySelector('article');
  if (!article) return '';
  const parts = [...article.querySelectorAll('h1, h2, h3, p, blockquote')]
    .map((el) => cleanText(el.textContent ?? ''))
    .filter(Boolean);
  return cleanText(parts.join('\n\n'));
}
