import html2canvas from 'html2canvas';
import Tesseract from 'tesseract.js';
import type { Chunk } from '../../shared/types';
import { chunkText } from './text';

export async function extractOCR(doc: Document): Promise<Chunk[]> {
  const canvases = [...doc.querySelectorAll('canvas')];
  const images: HTMLCanvasElement[] = [];

  if (canvases.length) {
    images.push(...canvases);
  } else {
    images.push(await html2canvas(doc.body, { useCORS: true, logging: false }));
  }

  const parts: string[] = [];
  for (const canvas of images.slice(0, 5)) {
    const result = await Tesseract.recognize(canvas, 'eng');
    if (result.data.text.trim()) parts.push(result.data.text);
  }

  return chunkText(parts.join('\n\n'), doc);
}
