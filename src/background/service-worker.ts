import { DEFAULT_SPEED, DEFAULT_VOICE, OFFSCREEN_URL, WELCOME_URL } from '../shared/constants';
import type { Chunk, ErrorPayload, ExtensionMessage, HighlightPayload, PlayPayload, ProgressPayload } from '../shared/types';

type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

let activeTabId: number | null = null;
let chunks: Chunk[] = [];
let currentChunkIndex = 0;
let voice = DEFAULT_VOICE;
let speed = DEFAULT_SPEED;
let state: PlaybackState = 'idle';
let offscreenReady = false;
let ttsReady = false;
let pendingFilterChunks: Chunk[] | null = null;
let offscreenCreation: Promise<void> | null = null;

registerContextMenu();

chrome.runtime.onInstalled.addListener((details) => {
  registerContextMenu();
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_URL) }).then(() => {
      void setBadge('↓', '#2f6fed');
      setTimeout(() => {
        void ensureOffscreen().then(() => {
          console.info('[ReadAloud service-worker] fire-and-forget install prewarm');
          sendToOffscreen({ type: 'PREWARM_OFFSCREEN' });
        }).catch((error) => {
          console.warn('[ReadAloud service-worker] install prewarm failed', error);
          void setBadge('!', '#b3261e');
        });
      }, 2_000);
    });
  }
});

chrome.runtime.onStartup.addListener(registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'readaloud-from-here' || !tab?.id) return;
  const tabId = tab.id;
  void (async () => {
    try {
      await ensureContentScript(tabId);
      await delay(300);
      await chrome.tabs.sendMessage(tabId, {
        type: 'READ_FROM_SELECTION',
        payload: { selectionText: info.selectionText ?? null }
      } satisfies ExtensionMessage);
    } catch (error) {
      console.error('[ReadAloud service-worker] context menu start failed', error);
    }
  })();
});

chrome.action.onClicked.addListener(async (tab) => {
  const targetTab = await getTargetTab(tab);
  console.info('[ReadAloud service-worker] toolbar clicked', { tabId: targetTab?.id, url: targetTab?.url });

  if (!targetTab?.id || !targetTab.url || !canRunOnUrl(targetTab.url)) {
    await setBadge('!', '#b3261e');
    return;
  }

  try {
    await sendToContentScript(targetTab.id, { type: 'START_FROM_ACTION' } satisfies ExtensionMessage);
  } catch (error) {
    console.error('[ReadAloud service-worker] content script message failed', error);
    await chrome.action.setBadgeText({ tabId: targetTab.id, text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ tabId: targetTab.id, color: '#b3261e' });
  }
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse).catch((error) => {
    const payload: ErrorPayload = { message: error instanceof Error ? error.message : String(error), recoverable: true };
    void notifyActiveTab({ type: 'ERROR', payload });
    sendResponse({ ok: false, error: payload.message });
  });
  return true;
});

async function handleMessage(message: ExtensionMessage, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case 'PREWARM':
      await prewarmOffscreen();
      return { ok: true };

    case 'PLAY':
      await startPlayback(message.payload as PlayPayload, sender.tab?.id ?? activeTabId);
      return { ok: true };

    case 'CHUNK_DONE':
      await handleChunkDone(message.payload as { chunkIndex?: number } | undefined);
      return { ok: true };

    case 'PLAYBACK_COMPLETE':
      await notifyActiveTab({ type: 'HIGHLIGHT', payload: { paragraphId: null, index: paragraphIds().length, total: paragraphIds().length } });
      await stopPlayback(false);
      return { ok: true };

    case 'PAUSE':
      state = 'paused';
      sendToOffscreen({ type: 'PAUSE_OFFSCREEN' });
      return { ok: true };

    case 'RESUME':
      state = 'playing';
      sendToOffscreen({ type: 'RESUME_OFFSCREEN' });
      return { ok: true };

    case 'STOP':
      await stopPlayback();
      return { ok: true };

    case 'SEEK_TO_PARAGRAPH':
      await seekToParagraph((message.payload as { paragraphId?: string } | undefined)?.paragraphId);
      return { ok: true };

    case 'SET_SPEED':
      speed = Number(message.payload) || DEFAULT_SPEED;
      await chrome.storage.local.set({ speed });
      sendToOffscreen({ type: 'SET_SPEED', payload: { speed } });
      return { ok: true };

    case 'SET_VOICE':
      voice = String(message.payload || DEFAULT_VOICE);
      await chrome.storage.local.set({ voice });
      return { ok: true };

    case 'MODEL_LOADING':
      await notifyActiveTab({ type: 'MODEL_LOADING', payload: normalizeProgress(message.payload as ProgressPayload) });
      return { ok: true };

    case 'MODEL_READY':
      ttsReady = true;
      await setBadge('', '#178a42');
      await notifyActiveTab({ type: 'MODEL_READY' });
      flushPendingFilter();
      return { ok: true };

    case 'HIGHLIGHT':
      await handlePlaybackHighlight(message.payload as Partial<HighlightPayload> | undefined);
      return { ok: true };

    case 'PLAYER_STATE':
      await notifyActiveTab(message);
      return { ok: true };

    case 'ERROR':
      await notifyActiveTab(message);
      return { ok: true };

    default:
      return { ok: true };
  }
}

async function startPlayback(payload: PlayPayload, tabId: number | null) {
  if (!tabId) throw new Error('No active tab available for playback.');
  if (!chrome.offscreen) throw new Error('Please update Chrome to use ReadAloud.');

  if (activeTabId && activeTabId !== tabId) {
    await notifyActiveTab({ type: 'ERROR', payload: { message: 'Playback moved to another tab.', recoverable: false } });
    sendToOffscreen({ type: 'STOP_OFFSCREEN' });
  }

  activeTabId = tabId;
  currentChunkIndex = 0;
  voice = payload.voice || DEFAULT_VOICE;
  speed = payload.speed || DEFAULT_SPEED;
  state = 'loading';

  chunks = payload.chunks;
  await sendAllChunks(chunks);
}

async function playCurrentChunk() {
  const chunk = chunks[currentChunkIndex];
  if (!chunk) {
    await notifyActiveTab({ type: 'HIGHLIGHT', payload: { paragraphId: null, index: 0, total: paragraphIds().length } });
    await stopPlayback(false);
    return;
  }

  state = 'playing';
  const highlight = progressForChunk(chunk);
  await notifyActiveTab({ type: 'HIGHLIGHT', payload: highlight });
  await notifyActiveTab({ type: 'PLAYER_PROGRESS', payload: highlight });
  await sendAllChunks(chunks.slice(currentChunkIndex));
}

async function handleChunkDone(payload?: { chunkIndex?: number }) {
  if (state === 'stopped' || state === 'idle') return;
  const doneIndex = typeof payload?.chunkIndex === 'number' ? payload.chunkIndex : currentChunkIndex;
  currentChunkIndex = Math.max(currentChunkIndex, doneIndex + 1);

  if (currentChunkIndex >= chunks.length) {
    await notifyActiveTab({ type: 'HIGHLIGHT', payload: { paragraphId: null, index: paragraphIds().length, total: paragraphIds().length } });
    await stopPlayback(false);
  }
}

async function stopPlayback(sendStop = true) {
  state = 'stopped';
  chunks = [];
  currentChunkIndex = 0;
  if (sendStop) sendToOffscreen({ type: 'STOP_OFFSCREEN' });
  activeTabId = null;
}

async function seekToParagraph(paragraphId?: string) {
  if (!paragraphId) return;

  const seekIndex = chunks.findIndex((chunk) => chunk.paragraphId === paragraphId);
  if (seekIndex < 0) return;

  currentChunkIndex = seekIndex;
  state = 'playing';
  await sendAllChunks(chunks.slice(seekIndex));
  await notifyActiveTab({ type: 'HIGHLIGHT', payload: progressForChunk(chunks[seekIndex]) });
}

async function handlePlaybackHighlight(payload?: Partial<HighlightPayload>) {
  if (!payload?.paragraphId) return;

  const chunkIndex = typeof payload.chunkIndex === 'number'
    ? payload.chunkIndex
    : chunks.findIndex((chunk) => chunk.paragraphId === payload.paragraphId);
  if (chunkIndex >= 0) currentChunkIndex = chunkIndex;

  const chunk = chunks[chunkIndex] ?? chunks.find((candidate) => candidate.paragraphId === payload.paragraphId);
  if (!chunk) return;

  const progress = progressForChunk(chunk);
  await notifyActiveTab({ type: 'HIGHLIGHT', payload: progress });
  await notifyActiveTab({ type: 'PLAYER_PROGRESS', payload: progress });
}

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('Please update Chrome to use ReadAloud.');

  if (offscreenCreation) {
    await offscreenCreation;
    return;
  }

  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    ttsReady = false;
    offscreenCreation = chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_URL),
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Kokoro TTS synthesis and audio playback'
      })
      .then(() => delay(100))
      .finally(() => {
        offscreenCreation = null;
      });
    await offscreenCreation;
  }
  offscreenReady = true;
}

function sendToOffscreen(message: ExtensionMessage): void {
  void ensureOffscreen().then(() => {
    chrome.runtime.sendMessage({ ...message, target: 'offscreen' }).catch((error) => {
      console.warn('[ReadAloud service-worker] offscreen message failed:', error instanceof Error ? error.message : String(error));
    });
  }).catch((error) => {
    console.warn('[ReadAloud service-worker] offscreen unavailable:', error instanceof Error ? error.message : String(error));
  });
}

async function prewarmOffscreen() {
  await ensureOffscreen();
  if (!offscreenReady) return;
  console.info('[ReadAloud service-worker] prewarming offscreen TTS');
  sendToOffscreen({ type: 'PREWARM_OFFSCREEN' });
  await setBadge('Ready', '#178a42');
}

async function filterChunks(rawChunks: Chunk[]): Promise<Chunk[]> {
  return rawChunks;
}

function filterTailInBackground(rawChunks: Chunk[]) {
  const firstBatch = rawChunks.slice(0, 3);
  const tail = rawChunks.slice(3);
  if (!tail.length) return;

  void filterChunks(tail).then((filteredTail) => {
    if (state === 'stopped' || state === 'idle') return;
    chunks = [...firstBatch, ...filteredTail].map((chunk, index) => ({ ...chunk, index }));
  });
}

function queueTailFilter(rawChunks: Chunk[]) {
  pendingFilterChunks = rawChunks;
  flushPendingFilter();
}

function flushPendingFilter() {
  if (!ttsReady || !pendingFilterChunks) return;
  const rawChunks = pendingFilterChunks;
  pendingFilterChunks = null;
  filterTailInBackground(rawChunks);
}

function paragraphIds(): string[] {
  return [...new Set(chunks.map((chunk) => chunk.paragraphId))];
}

function progressForChunk(chunk: Chunk): HighlightPayload {
  const ids = paragraphIds();
  return {
    paragraphId: chunk.paragraphId,
    index: Math.max(0, ids.indexOf(chunk.paragraphId)),
    total: ids.length,
    chunkIndex: chunk.index
  };
}

async function sendAllChunks(targetChunks: Chunk[]) {
  if (!targetChunks.length) {
    await stopPlayback(false);
    return;
  }

  state = 'playing';
  const message = {
    type: 'TTS_ALL_CHUNKS',
    payload: { chunks: targetChunks, voice, speed }
  } satisfies ExtensionMessage<PlayPayload>;

  sendToOffscreen(message);
}

async function notifyActiveTab(message: ExtensionMessage) {
  if (!activeTabId) return;
  await sendToContentScript(activeTabId, message).catch(() => undefined);
}

function normalizeProgress(progress: ProgressPayload): ProgressPayload {
  return {
    ...progress,
    loaded: progress.loaded ?? 0,
    total: progress.total ?? 0,
    modelName: progress.modelName ?? 'Kokoro'
  };
}

function canRunOnUrl(url: string) {
  return /^https?:\/\//.test(url) || /^file:\/\//.test(url);
}

async function getTargetTab(tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab | undefined> {
  if (tab.id && tab.url) return tab;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

async function sendToContentScript(tabId: number, message: ExtensionMessage) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
  }

  await ensureContentScript(tabId);
  await delay(500);
  return chrome.tabs.sendMessage(tabId, message);
}

async function ensureContentScript(tabId: number) {
  console.info('[ReadAloud service-worker] ensuring manifest content scripts', { tabId });
  await injectManifestContentScripts(tabId);
}

async function injectManifestContentScripts(tabId: number) {
  const manifest = chrome.runtime.getManifest();
  const contentScripts = manifest.content_scripts ?? [];

  for (const contentScript of contentScripts) {
    if (contentScript.css?.length) {
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: false },
        files: contentScript.css
      });
    }

    if (contentScript.js?.length) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: contentScript.js,
        world: 'ISOLATED'
      });
    }
  }
}

function isMissingReceiverError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Receiving end does not exist') || message.includes('Could not establish connection');
}

function delay(ms: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));
}

async function setBadge(text: string, color: string) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

function registerContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'readaloud-from-here',
        title: 'Read aloud from here',
        contexts: ['selection', 'page']
      }, () => {
        void chrome.runtime.lastError;
      });
    });
  } catch {
    // Context menus are unavailable in some restricted extension contexts.
  }
}
