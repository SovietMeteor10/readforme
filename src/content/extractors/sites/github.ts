import { cleanText } from '../text';

export function extractGithub(doc: Document): string {
  const markdown = doc.querySelector('.markdown-body');
  if (markdown) return cleanText(markdown.textContent ?? '');

  const comments = [...doc.querySelectorAll('.comment-body')]
    .map((el) => cleanText(el.textContent ?? ''))
    .filter(Boolean);
  return cleanText(comments.join('\n\n'));
}
