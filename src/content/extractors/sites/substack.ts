import { cleanText } from '../text';

export function extractSubstack(doc: Document): string {
  const root = doc.querySelector('.available-content .body, .post-content, article');
  if (!root) return '';
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[class*="paywall"], [class*="subscribe"], [class*="subscription"], iframe, script, style').forEach((el) => el.remove());
  return cleanText(clone.textContent ?? '');
}
