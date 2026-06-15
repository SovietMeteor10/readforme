import { DEFAULT_SPEED, DEFAULT_VOICE, MIN_TEXT_LENGTH } from '../shared/constants';
import type { ErrorPayload, ExtensionMessage, HighlightPayload, ProgressPayload } from '../shared/types';
import { extractContent } from './extractors';
import { cleanText, splitSentences } from './extractors/text';
import { ReadAloudPlayer } from './player/player';
import type { Chunk } from '../shared/types';

declare global {
  interface Window {
    __readAloudActive?: boolean;
    __readAloudInjected?: boolean;
    __readAloudPlayer?: ReadAloudPlayer | null;
    __readAloudExtractionPromise?: Promise<void> | null;
    __readAloudContextElement?: Element | null;
    __readAloudLastRightClick?: Element | null;
    __readAloudReadingSelection?: boolean;
    __readAloudClickHandlerAttached?: boolean;
  }
}

if (window.__readAloudActive) {
  registerMessageListener();
} else {
  window.__readAloudActive = true;
  initReadAloud();
}

function initReadAloud() {
  window.__readAloudPlayer ??= null;
  window.__readAloudExtractionPromise ??= null;
  window.__readAloudContextElement ??= null;
  window.__readAloudLastRightClick ??= null;
  window.__readAloudReadingSelection ??= false;
  window.__readAloudClickHandlerAttached ??= false;

  registerMessageListener();
}

function registerMessageListener() {
  if (!window.__readAloudInjected) {
    window.__readAloudInjected = true;
    document.addEventListener('contextmenu', (event) => {
      window.__readAloudLastRightClick = event.target instanceof Element ? event.target : null;
      window.__readAloudContextElement = findReadableElement(event.target);
    }, true);
    chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
      console.info('[ReadAloud content] received message', message.type);
      void handleMessage(message).then(sendResponse).catch((error) => {
        showError(error instanceof Error ? error.message : String(error));
        sendResponse({ ok: false });
      });
      return true;
    });
  }
}

async function handleMessage(message: ExtensionMessage) {
  switch (message.type) {
    case 'START_FROM_ACTION':
      startReading('toolbar');
      return { ok: true };
    case 'READ_FROM_SELECTION': {
      const payload = message.payload as { selectionText?: string | null } | undefined;
      const selectionText = payload?.selectionText?.trim() ?? null;
      if (selectionText && selectionText.length > 10) {
        startReading('context', selectionText);
        return { ok: true };
      }

      const rightClickEl = window.__readAloudLastRightClick ?? null;
      const player = document.getElementById('readaloud-player');
      const readable = rightClickEl?.closest('p, h1, h2, h3, h4, li, article, [role="main"]');
      if (rightClickEl && readable && !player?.contains(rightClickEl)) {
        startReading('context', null);
        return { ok: true };
      }

      console.info('[ReadAloud content] READ_FROM_SELECTION ignored - no valid target');
      return { ok: true };
    }
    case 'HIGHLIGHT':
      if (!(message.payload as HighlightPayload).paragraphId) clearAllHighlights();
      getPlayer().highlight(message.payload as HighlightPayload);
      return { ok: true };
    case 'HIGHLIGHT_WORD':
      highlightWord(message.payload as { paragraphId?: string; wordIndex?: number } | undefined);
      return { ok: true };
    case 'PLAYER_PROGRESS':
      getPlayer().setProgress((message.payload as HighlightPayload).index + 1, (message.payload as HighlightPayload).total);
      return { ok: true };
    case 'PLAYER_STATE':
      updatePlayerState(message.payload as { state?: string; total?: number } | undefined);
      return { ok: true };
    case 'STOP':
      clearAllHighlights();
      return { ok: true };
    case 'MODEL_LOADING':
      getPlayer().setModelProgress(message.payload as ProgressPayload);
      return { ok: true };
    case 'MODEL_READY':
      getPlayer().markModelReady();
      return { ok: true };
    case 'ERROR':
      getPlayer().showError(message.payload as ErrorPayload);
      return { ok: true };
    default:
      return { ok: true };
  }
}

function startReading(mode: 'toolbar' | 'context', selectionText?: string | null) {
  const player = document.getElementById('readaloud-player');
  // Ignore repeat toolbar clicks while already playing or still loading; only an
  // explicit text selection is allowed to restart from the toolbar.
  if ((player?.dataset.state === 'playing' || player?.dataset.state === 'loading') && !selectionText) {
    console.info('[ReadAloud content] already active, ignoring repeat start');
    return;
  }

  window.__readAloudExtractionPromise = null;
  console.info('[ReadAloud content] toolbar start received');
  const ui = getPlayer();
  ui.setState('loading', 'Extracting page...');

  window.__readAloudExtractionPromise = (async () => {
    try {
      const settings = await chrome.storage.local.get({ voice: DEFAULT_VOICE, speed: DEFAULT_SPEED });
      const selected = selectionText ? chunksFromText(selectionText, 'ra-selection') : getSelectedTextChunks();
      const fromHere = mode === 'context' && !selected ? getChunksFromContextElement() : null;
      const chunks = prepareChunksForHighlight(selected ?? fromHere ?? await extractContent(document));
      attachParagraphClickHandlers();
      window.__readAloudReadingSelection = !!selected;
      console.info('[ReadAloud content] extracted chunks', chunks.length);

      const textLength = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      if (textLength < MIN_TEXT_LENGTH) {
        throw new Error('Nothing to read on this page. Try selecting text first.');
      }

      ui.setState('loading', selected ? 'Reading selected text...' : 'Starting audio...');
      await chrome.runtime.sendMessage({
        type: 'PLAY',
        payload: {
          chunks,
          voice: String(settings.voice || DEFAULT_VOICE),
          speed: Number(settings.speed || DEFAULT_SPEED)
        }
      });
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      window.__readAloudExtractionPromise = null;
    }
  })();
}

function getPlayer(): ReadAloudPlayer {
  window.__readAloudPlayer ??= new ReadAloudPlayer();
  return window.__readAloudPlayer;
}

function showError(message: string) {
  getPlayer().showError({ message, recoverable: true });
}

function getSelectedTextChunks(): Chunk[] | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;

  const selectedText = selection.toString().trim();
  if (selectedText.length < 20) return null;

  const range = selection.getRangeAt(0);
  const element = findReadableElement(range.commonAncestorContainer);
  if (element) tagElement(element, 0, 'ra-selection');
  return chunksFromText(selectedText, 'ra-selection');
}

function getChunksFromContextElement(): Chunk[] | null {
  const start = findReadableElement(window.__readAloudContextElement ?? null);
  if (!start) return null;

  const elements = getReadableElements();
  const startIndex = elements.indexOf(start);
  if (startIndex < 0) return chunksFromText(cleanText(start.textContent ?? ''), tagElement(start, 0));

  const chunks: Chunk[] = [];
  elements.slice(startIndex).forEach((element, elementIndex) => {
    const paragraphId = tagElement(element, elementIndex);
    chunks.push(...chunksFromText(cleanText(element.textContent ?? ''), paragraphId, chunks.length));
  });
  return chunks.length ? chunks : null;
}

function chunksFromText(text: string, paragraphId: string, startIndex = 0): Chunk[] {
  let wordOffset = 0;
  return splitSentences(cleanText(text))
    .filter((sentence) => sentence.trim().length > 10)
    .map((sentence, index) => {
      const chunk = {
        index: startIndex + index,
        text: sentence.trim(),
        paragraphId,
        wordOffset
      };
      wordOffset += countWords(sentence);
      return chunk;
    });
}

function getReadableElements(): HTMLElement[] {
  return [...document.querySelectorAll('p, h1, h2, h3, h4, li, blockquote')]
    .filter((element): element is HTMLElement => element instanceof HTMLElement && cleanText(element.textContent ?? '').length > 20);
}

function findReadableElement(target: EventTarget | Node | Element | null): HTMLElement | null {
  const node = target instanceof Node ? target : null;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node instanceof HTMLElement ? node : null;
  return element?.closest('p, h1, h2, h3, h4, li, blockquote, article, main, [role="main"]') as HTMLElement | null;
}

function tagElement(element: HTMLElement, index: number, forcedId?: string): string {
  const paragraphId = forcedId || element.dataset.readaloudId || `ra-context-${Date.now().toString(36)}-${index}`;
  element.dataset.readaloudId = paragraphId;
  element.setAttribute('data-readaloud-id', paragraphId);
  return paragraphId;
}

function clearAllHighlights() {
  document.querySelectorAll('.ra-highlight').forEach((el) => el.classList.remove('ra-highlight'));
  document.querySelectorAll('.ra-word-active').forEach((el) => el.classList.remove('ra-word-active'));
  document.querySelectorAll('[data-readaloud-id]').forEach((el) => el.removeAttribute('data-readaloud-id'));
  window.__readAloudReadingSelection = false;
}

function attachParagraphClickHandlers() {
  if (window.__readAloudClickHandlerAttached) return;
  window.__readAloudClickHandlerAttached = true;
  document.body.addEventListener('click', handleParagraphClick, true);
}

function handleParagraphClick(event: MouseEvent) {
  const player = document.getElementById('readaloud-player');
  if (!player || player.dataset.state === 'hidden') return;
  if (player.contains(event.target as Node)) return;

  const target = event.target instanceof Element ? event.target : null;
  const paragraph = target?.closest('[data-readaloud-id]');
  const paragraphId = paragraph?.getAttribute('data-readaloud-id');
  if (!paragraphId || paragraphId === 'ra-selection') return;

  event.preventDefault();
  event.stopPropagation();
  console.log('[RA:content] seeking to paragraph:', paragraphId);
  chrome.runtime.sendMessage({ type: 'SEEK_TO_PARAGRAPH', payload: { paragraphId } });
}

function updatePlayerState(payload?: { state?: string; total?: number }) {
  const player = getPlayer();
  if (payload?.state === 'preparing') {
    player.setState('loading', `Preparing ${payload.total ?? 0} chunks...`);
  } else if (payload?.state === 'playing') {
    player.setState('playing');
  }
}

function prepareChunksForHighlight(inputChunks: Chunk[]): Chunk[] {
  const paragraphOffsets = new Map<string, number>();
  const prepared = inputChunks.map((chunk, index) => {
    const currentOffset = paragraphOffsets.get(chunk.paragraphId) ?? 0;
    paragraphOffsets.set(chunk.paragraphId, currentOffset + countWords(chunk.text));
    return { ...chunk, index, wordOffset: chunk.wordOffset ?? currentOffset };
  });

  for (const paragraphId of new Set(prepared.map((chunk) => chunk.paragraphId))) {
    const element = document.querySelector(`[data-readaloud-id="${CSS.escape(paragraphId)}"]`);
    if (element) wrapWordsInSpans(element, paragraphId);
  }

  return prepared;
}

function wrapWordsInSpans(el: Element, paragraphId: string): void {
  if (el.querySelector('.ra-word')) return;

  let wordSpanIndex = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (parent.closest('#readaloud-player, .ra-word, a, button, input, textarea, select, script, style')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const parts = textNode.textContent?.split(/(\s+)/) ?? [];
    const fragment = document.createDocumentFragment();

    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        fragment.append(document.createTextNode(part));
      } else if (part.length > 0) {
        const span = document.createElement('span');
        span.className = 'ra-word';
        span.dataset.paraId = paragraphId;
        span.dataset.wordIdx = String(wordSpanIndex);
        span.textContent = part;
        wordSpanIndex += 1;
        fragment.append(span);
      }
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

function highlightWord(payload?: { paragraphId?: string; wordIndex?: number }) {
  if (!payload?.paragraphId || typeof payload.wordIndex !== 'number') return;

  document.querySelectorAll('.ra-word-active').forEach((el) => {
    el.classList.remove('ra-word-active');
  });

  const wordEl = document.querySelector(
    `.ra-word[data-para-id="${CSS.escape(payload.paragraphId)}"][data-word-idx="${payload.wordIndex}"]`
  );
  wordEl?.classList.add('ra-word-active');
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
