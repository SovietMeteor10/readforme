import { cleanText } from '../text';

export function extractArxiv(doc: Document): string {
  const article = doc.querySelector('.ltx_article');
  if (article) {
    const clone = article.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.ltx_authors, .ltx_bibliography, .ltx_role_affiliation, .ltx_tag_equation, math, img').forEach((el) => el.remove());
    return cleanText(clone.textContent ?? '');
  }

  const abs = doc.querySelector('#abs');
  const paragraphs = [...doc.querySelectorAll('.ltx_p, blockquote.abstract')].map((el) => el.textContent ?? '');
  return cleanText([abs?.textContent ?? '', ...paragraphs].join('\n\n'));
}
