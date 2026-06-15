import { cleanText } from '../text';

export function extractGoogleDocs(doc: Document): string {
  const root = doc.querySelector('.kix-paginateddocumentplugin-content');
  if (!root) return '';
  const paragraphs = [...root.querySelectorAll('.kix-paragraphrenderer')]
    .map((el) => cleanText(el.textContent ?? ''))
    .filter(Boolean);
  return cleanText(paragraphs.join('\n\n'));
}
