import { Readability } from '@mozilla/readability';

export function extractReadability(doc: Document): string {
  const clone = doc.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  return article?.textContent?.trim() ?? '';
}
