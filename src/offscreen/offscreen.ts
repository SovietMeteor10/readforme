import * as ort from 'onnxruntime-web';
import { env as transformersEnv } from '@huggingface/transformers';
import { DEFAULT_SPEED, DEFAULT_VOICE, MODEL_NAME } from '../shared/constants';
import type { Chunk, ExtensionMessage, PlayPayload, ProgressPayload, TtsBatchPayload, TtsChunkPayload } from '../shared/types';

type KokoroModule = typeof import('kokoro-js');
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>;

interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

interface SynthesisedChunk {
  chunkIndex: number;
  paragraphId: string;
  text: string;
  samples: Float32Array;
  sampleRate: number;
  wordTimings: WordTiming[];
  durationMs: number;
  wordOffset: number;
}

interface PendingChunk {
  result: SynthesisedChunk;
}

interface AudioSamples {
  samples: Float32Array;
  sampleRate: number;
}

let tts: KokoroInstance | null = null;
let ttsLoading: Promise<KokoroInstance> | null = null;
let currentSpeed = DEFAULT_SPEED;
let currentVoice = DEFAULT_VOICE;
let playQueue: Chunk[] = [];
let playHead = 0;
let pendingNext: PendingChunk | null = null;
let pendingNextIdx = -1;
let isFetching = false;
let isPlaying = false;
let isPaused = false;
let waitingForNext = false;
let audioCtx: AudioContext | null = null;
let gainNode: GainNode | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let playbackStartCtxTime = 0;
let currentChunk: SynthesisedChunk | null = null;
let wordHighlightTimer: ReturnType<typeof globalThis.setInterval> | null = null;
let currentGen = 0;
let kokoroModulePromise: Promise<KokoroModule> | null = null;
let lastProgressPercent = -1;

const wasmPath = chrome.runtime.getURL('assets/ort/');
ort.env.logLevel = 'error';
const ortWasmEnv = (ort.env as typeof ort.env & { wasm?: { wasmPaths?: string; numThreads?: number } }).wasm;
if (ortWasmEnv) {
  ortWasmEnv.wasmPaths = wasmPath;
  ortWasmEnv.numThreads = 1;
}
transformersEnv.useBrowserCache = true;
transformersEnv.allowRemoteModels = true;
const transformersWasmEnv = transformersEnv.backends.onnx.wasm;
if (transformersWasmEnv) {
  transformersWasmEnv.wasmPaths = wasmPath;
  transformersWasmEnv.numThreads = 1;
}
console.info('[ReadAloud offscreen] ONNX WASM path:', wasmPath);

// Start a silent AudioContext immediately on module load to keep the offscreen
// document alive. Chrome closes AUDIO_PLAYBACK offscreen documents that produce
// no audio. This must run before any async work (model loading, synthesis).
(function bootstrapKeepAlive() {
  try {
    const ctx = new AudioContext({ sampleRate: 24000 });
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // 1s silence
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(ctx.destination);
    src.start(0);
    // Store so getAudioCtx() reuses this same context
    audioCtx = ctx;
    gainNode = ctx.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(ctx.destination);
    console.log('[RA:offscreen] bootstrap AudioContext started, state:', ctx.state);
  } catch (e) {
    console.warn('[RA:offscreen] bootstrap keepalive failed:', e);
  }
})();

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  // Fire and forget. The offscreen document never sends responses through the
  // message channel — everything it reports to the SW goes via separate
  // chrome.runtime.sendMessage calls (MODEL_READY, HIGHLIGHT, CHUNK_DONE, ...).
  // Returning true here would tell Chrome to hold the channel open waiting for a
  // response that never comes (getTTS() takes seconds), which Chrome treats as a
  // crash and tears the offscreen document down.
  if (message.target !== 'offscreen') return;
  void handleMessage(message).catch((error) => {
    console.error('[RA:offscreen] message handler error:', error);
    chrome.runtime.sendMessage({
      type: 'ERROR',
      payload: { message: error instanceof Error ? error.message : String(error), recoverable: true }
    }).catch(() => undefined);
  });
  // Return nothing — do NOT return true.
});

async function handleMessage(message: ExtensionMessage): Promise<void> {
  switch (message.type) {
    case 'PREWARM_OFFSCREEN':
      console.info('[ReadAloud offscreen] prewarming Kokoro only');
      void getTTS().catch((error) => {
        console.warn('[ReadAloud offscreen] prewarm failed', error);
      });
      return;
    case 'CLASSIFY_CHUNKS':
      // No longer used (filtering happens in the SW); kept for completeness.
      heuristicFilter(message.payload as Chunk[]);
      return;
    case 'TTS_CHUNK': {
      const payload = message.payload as TtsChunkPayload;
      await startPlayback(payload.chunk ? [payload.chunk] : [], payload.voice, payload.speed);
      return;
    }
    case 'TTS_BATCH': {
      const payload = message.payload as TtsBatchPayload;
      await startPlayback(payload.chunks ?? [], payload.voice, payload.speed);
      return;
    }
    case 'TTS_ALL_CHUNKS': {
      const payload = message.payload as PlayPayload;
      await startPlayback(payload.chunks ?? [], payload.voice, payload.speed);
      return;
    }
    case 'SET_SPEED':
      currentSpeed = readSpeed(message.payload);
      if (currentSource) currentSource.playbackRate.value = currentSpeed;
      return;
    case 'PAUSE_OFFSCREEN':
      isPaused = true;
      isPlaying = false;
      if (audioCtx && audioCtx.state === 'running') {
        void audioCtx.suspend();
      }
      stopWordHighlighting();
      return;
    case 'RESUME_OFFSCREEN':
      isPaused = false;
      if (currentSource && audioCtx && audioCtx.state === 'suspended') {
        await audioCtx.resume().catch((error) => {
          console.warn('[ReadAloud offscreen] resume failed', error);
        });
        isPlaying = true;
        if (currentChunk) startWordHighlighting(currentChunk);
      } else if (!currentSource && waitingForNext) {
        advancePlayback(currentGen);
      }
      return;
    case 'STOP_OFFSCREEN':
      stopCurrentPlayback();
      return;
    default:
      return;
  }
}

async function getTTS(): Promise<KokoroInstance> {
  if (tts) return tts;
  if (ttsLoading) return ttsLoading;

  ttsLoading = (async () => {
    const { KokoroTTS } = await loadKokoro();
    try {
      console.info('[ReadAloud offscreen] Loading Kokoro with WASM q8', {
        useBrowserCache: transformersEnv.useBrowserCache,
        allowRemoteModels: transformersEnv.allowRemoteModels,
        wasmThreads: transformersWasmEnv?.numThreads
      });
      tts = await KokoroTTS.from_pretrained(MODEL_NAME, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: forwardProgress
      });
    } catch (error) {
      ttsLoading = null;
      throw error;
    }

    ttsLoading = null;
    chrome.runtime.sendMessage({ type: 'MODEL_READY' }).catch(() => undefined);
    console.log(
      '[ReadAloud offscreen] Kokoro ready, methods:',
      Object.getOwnPropertyNames(Object.getPrototypeOf(tts))
    );
    return tts;
  })();

  ttsLoading.catch(() => {
    ttsLoading = null;
  });

  return ttsLoading;
}

async function loadKokoro(): Promise<KokoroModule> {
  if (!kokoroModulePromise) {
    kokoroModulePromise = import('kokoro-js');
  }

  return kokoroModulePromise;
}

function heuristicFilter(rawChunks: Chunk[]): Chunk[] {
  const skipPatterns = [
    /^(menu|nav|navigation|skip to|jump to|contents|search)/i,
    /^\d+$/,
    /^(home|about|contact|login|sign in|register|subscribe)$/i,
    /^(previous|next|page \d+)$/i,
    /^\[.*\]$/
  ];

  const filtered = rawChunks.filter((chunk) => {
    const text = chunk.text.trim();
    if (text.length < 20) return false;
    return !skipPatterns.some((pattern) => pattern.test(text));
  });

  return (filtered.length ? filtered : rawChunks).map((chunk, index) => ({ ...chunk, index }));
}

async function startPlayback(chunks: Chunk[], voice: string, speed: number) {
  currentGen += 1;
  const gen = currentGen;

  try {
    cleanupReadAloudDomArtifacts(document);
    stopCurrentPlayback(false);
    startKeepAlive();

    playQueue = chunks;
    playHead = 0;
    currentVoice = voice || currentVoice || DEFAULT_VOICE;
    currentSpeed = speed || currentSpeed || DEFAULT_SPEED;
    pendingNext = null;
    pendingNextIdx = -1;
    waitingForNext = false;

    if (!chunks.length) {
      sendError('No chunks to play');
      return;
    }

    // Load model (instant if cached, ~2s on first run)
    try {
      await getTTS();
    } catch (error) {
      sendError(`Failed to load voice model: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (gen !== currentGen) return;

    // Synthesise chunk 0 — this takes ~2s, user sees model progress bar
    const first = await synthesiseOne(chunks[0], gen);
    if (gen !== currentGen) return;

    if (!first) {
      // chunk 0 failed, try chunk 1. Keep playHead at 0 so advancePlayback
      // (which pre-increments) lands on chunk 1 rather than skipping to chunk 2.
      if (chunks.length > 1) {
        playHead = 0;
        fetchAndStage(1, gen);
        waitingForNext = true;
      } else {
        sendError('Synthesis failed');
      }
      return;
    }

    // Start synthesising chunk 1 in background immediately
    if (chunks.length > 1) fetchAndStage(1, gen);

    // Play chunk 0 now — no waiting
    playResult(first, gen);
  } catch (error) {
    console.error('[ReadAloud offscreen] startPlayback failed:', error);
    stopCurrentPlayback();
    sendError(error instanceof Error ? error.message : 'Synthesis failed');
  }
}

function fetchAndStage(index: number, gen: number) {
  if (gen !== currentGen || isFetching || pendingNext || index >= playQueue.length || index === pendingNextIdx) return;
  isFetching = true;
  pendingNextIdx = index;

  void synthesiseOne(playQueue[index], gen).then((result) => {
    isFetching = false;
    if (!result || gen !== currentGen) return;

    pendingNext = { result };
    console.log(`[RA:tts] staged chunk ${index}: ${(result.durationMs / 1000).toFixed(1)}s`);

    if (waitingForNext && !isPlaying && !isPaused && gen === currentGen) {
      advancePlayback(gen);
    }
  }).catch((error) => {
    isFetching = false;
    console.error('[ReadAloud offscreen] prefetch failed', error);
    pendingNext = null;
    pendingNextIdx = index;
    if (waitingForNext && !isPlaying && !isPaused && gen === currentGen) advancePlayback(gen);
  });
}

function advancePlayback(gen: number) {
  console.log('[RA] advancePlayback called, playHead:', playHead, 'pendingNext:', pendingNextIdx, 'isFetching:', isFetching);
  if (gen !== currentGen || isPaused) return;

  playHead += 1;

  if (playHead >= playQueue.length) {
    isPlaying = false;
    completePlayback(gen);
    return;
  }

  if (pendingNext && pendingNextIdx === playHead) {
    const next = pendingNext;
    pendingNext = null;
    pendingNextIdx = -1;
    waitingForNext = false;

    if (playHead + 1 < playQueue.length) fetchAndStage(playHead + 1, gen);
    void playDirect(next.result, gen);
    return;
  }

  if (pendingNextIdx === playHead && isFetching) {
    waitingForNext = true;
    console.log(`[RA:tts] waiting for chunk ${playHead} synthesis`);
    return;
  }

  if (pendingNextIdx === playHead) {
    pendingNextIdx = -1;
    advancePlayback(gen);
    return;
  }

  waitingForNext = true;
  console.log(`[RA:tts] chunk ${playHead} not staged, synthesising now`);
  void synthesiseOne(playQueue[playHead], gen).then((result) => {
    if (!result || gen !== currentGen) return;
    waitingForNext = false;
    if (playHead + 1 < playQueue.length) fetchAndStage(playHead + 1, gen);
    playResult(result, gen);
  }).catch((error) => {
    console.error('[ReadAloud offscreen] fallback synthesis failed', error);
    advancePlayback(gen);
  });
}

function playResult(result: SynthesisedChunk, gen: number) {
  void playDirect(result, gen);
}

async function playDirect(result: SynthesisedChunk, gen: number) {
  if (gen !== currentGen) return;

  const ctx = getAudioCtx();

  console.log('[RA:audio] playDirect called:', {
    chunkIndex: result.chunkIndex,
    samplesLength: result.samples.length,
    sampleRate: result.sampleRate,
    durationMs: result.durationMs,
    audioCtxState: ctx.state,
    gainValue: gainNode?.gain.value
  });

  // Ensure context is running — Chrome may suspend it. Must await before
  // source.start(0); starting into a suspended context produces silence.
  if (ctx.state !== 'running') {
    try {
      await ctx.resume();
      console.log('[RA:audio] AudioContext resumed, state now:', ctx.state);
    } catch (e) {
      console.error('[RA:audio] resume() failed:', e);
    }
  }
  if (gen !== currentGen) return;

  // Stop any source still attached before starting the next one.
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }

  isPlaying = true;
  waitingForNext = false;
  currentChunk = result;

  // Build an AudioBuffer straight from the Float32Array samples — no WAV
  // encode, no blob URL, no HTMLAudioElement autoplay gate.
  const audioBuffer = ctx.createBuffer(1, result.samples.length, result.sampleRate);
  audioBuffer.getChannelData(0).set(result.samples);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = currentSpeed;
  source.connect(gainNode ?? ctx.destination);
  currentSource = source;

  chrome.runtime.sendMessage({
    type: 'HIGHLIGHT',
    payload: {
      paragraphId: result.paragraphId,
      index: result.chunkIndex,
      total: playQueue.length,
      chunkIndex: result.chunkIndex
    }
  }).catch(() => undefined);
  chrome.runtime.sendMessage({
    type: 'PLAYER_STATE',
    payload: { state: 'playing', total: playQueue.length }
  }).catch(() => undefined);
  chrome.runtime.sendMessage({
    type: 'PLAYER_PROGRESS',
    payload: {
      paragraphId: result.paragraphId,
      index: result.chunkIndex,
      total: playQueue.length,
      chunkIndex: result.chunkIndex
    }
  }).catch(() => undefined);

  playbackStartCtxTime = ctx.currentTime;
  startWordHighlighting(result);

  source.onended = () => {
    if (gen !== currentGen || source !== currentSource) return;
    isPlaying = false;
    currentSource = null;
    currentChunk = null;
    stopWordHighlighting();
    chrome.runtime.sendMessage({ type: 'CHUNK_DONE', payload: { chunkIndex: result.chunkIndex } }).catch(() => undefined);
    advancePlayback(gen);
  };

  console.log(`[RA:audio] playing chunk ${result.chunkIndex} via AudioContext, ${result.durationMs.toFixed(0)}ms`);
  source.start(0);
  console.log('[RA:audio] source.start(0) called, context time:', ctx.currentTime);
}

async function synthesiseOne(chunk: Chunk, gen: number): Promise<SynthesisedChunk | null> {
  if (gen !== currentGen) return null;

  const text = chunk.text?.trim();
  if (!text || text.length < 2) return null;

  let engine: KokoroInstance;
  try {
    engine = await getTTS();
  } catch (error) {
    console.error('[ReadAloud offscreen] TTS load failed:', error);
    sendError(`Failed to load voice model: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  if (gen !== currentGen) return null;

  try {
    console.log(`[RA:tts] generating chunk ${chunk.index}: "${text.slice(0, 60)}"`);

    const result = await engine.generate(text, {
      voice: (currentVoice || DEFAULT_VOICE) as any
    }) as unknown;

    const rawResult = result as { audio?: unknown; sampling_rate?: unknown } | null;
    console.log(
      '[RA:tts] raw result type:',
      result && typeof result === 'object' ? result.constructor?.name : typeof result,
      'audio:',
      rawResult?.audio && typeof rawResult.audio === 'object' ? rawResult.audio.constructor?.name : typeof rawResult?.audio,
      rawResult?.audio instanceof Float32Array ? rawResult.audio.length : undefined,
      'sr:',
      rawResult?.sampling_rate
    );
    console.log('[RA:tts] generate() returned:', describeGenerateResult(result));

    if (gen !== currentGen) return null;

    const extracted = extractAudioSamples(result);
    if (!extracted) {
      console.error('[ReadAloud offscreen] generate returned an unknown audio shape', summarizeUnknownResult(result));
      return null;
    }

    const { samples, sampleRate } = extracted;
    if (!samples.length) {
      console.error('[ReadAloud offscreen] generate returned empty audio samples');
      return null;
    }

    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      console.warn('[ReadAloud offscreen] generate returned invalid sample rate', sampleRate);
      return null;
    }

    const durationMs = (samples.length / sampleRate) * 1000;
    console.log(`[RA:tts] chunk ${chunk.index} ready: ${(durationMs / 1000).toFixed(1)}s`);

    return {
      chunkIndex: chunk.index,
      paragraphId: chunk.paragraphId,
      text,
      samples,
      sampleRate,
      wordTimings: estimateWordTimings(text, durationMs),
      durationMs,
      wordOffset: chunk.wordOffset ?? 0
    };
  } catch (error) {
    console.error(`[ReadAloud offscreen] synthesis failed for chunk ${chunk.index}`, error);
    return null;
  }
}

function extractAudioSamples(result: unknown): AudioSamples | null {
  if (result instanceof Float32Array) {
    return { samples: result, sampleRate: 24000 };
  }

  if (Array.isArray(result)) {
    const first = result[0];
    if (first instanceof Float32Array) {
      return { samples: first, sampleRate: readSampleRate(result[1]) };
    }
    return extractAudioSamples(first);
  }

  if (!result || typeof result !== 'object') return null;

  const record = result as Record<string, unknown>;
  const samples = findFloat32Samples(record.audio)
    ?? findFloat32Samples(record.data)
    ?? findFloat32Samples(record.samples)
    ?? findFloat32Samples(record.waveform)
    ?? findFloat32Samples(record.output)
    ?? findFloat32Samples(record[0]);

  if (!samples) return null;

  return {
    samples,
    sampleRate: readSampleRate(record.sampling_rate ?? record.sample_rate ?? record.sampleRate ?? record.rate)
  };
}

function findFloat32Samples(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value;
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  return findFloat32Samples(record.data)
    ?? findFloat32Samples(record.audio)
    ?? findFloat32Samples(record.samples)
    ?? findFloat32Samples(record.cpuData);
}

function readSampleRate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 24000;
}

function describeGenerateResult(result: unknown) {
  if (!result) {
    return {
      type: typeof result,
      keys: 'null',
      hasAudio: false,
      hasData: false,
      hasSamplingRate: false,
      isArray: false,
      constructor: null
    };
  }

  const record = typeof result === 'object' ? result as Record<string, unknown> : {};
  return {
    type: typeof result,
    keys: typeof result === 'object' ? Object.keys(record) : [],
    hasAudio: record.audio instanceof Float32Array,
    hasData: record.data instanceof Float32Array,
    hasSamplingRate: typeof record.sampling_rate === 'number',
    isArray: Array.isArray(result),
    constructor: typeof result === 'object' ? result.constructor?.name : undefined
  };
}

function summarizeUnknownResult(result: unknown) {
  if (!result || typeof result !== 'object') return result;

  const record = result as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).slice(0, 12).map(([key, value]) => {
    if (value instanceof Float32Array) return [key, `Float32Array(${value.length})`];
    if (ArrayBuffer.isView(value)) return [key, `${value.constructor.name}(${value.byteLength} bytes)`];
    if (Array.isArray(value)) return [key, `Array(${value.length})`];
    if (value && typeof value === 'object') return [key, { constructor: value.constructor?.name, keys: Object.keys(value).slice(0, 12) }];
    return [key, value];
  }));
}

function stopCurrentPlayback(cancelCurrent = true) {
  if (cancelCurrent) currentGen += 1;
  isPaused = false;
  isPlaying = false;
  isFetching = false;
  waitingForNext = false;

  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }

  // Keep the AudioContext alive for reuse, but un-suspend it so the next
  // playback starts cleanly.
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }

  currentChunk = null;
  pendingNext = null;
  pendingNextIdx = -1;

  playQueue = [];
  playHead = 0;
  stopWordHighlighting();
}

function completePlayback(gen: number) {
  if (gen !== currentGen) return;
  chrome.runtime.sendMessage({ type: 'PLAYBACK_COMPLETE' }).catch(() => undefined);
}

// Single AudioContext for the whole session. AudioBufferSourceNode.start() is
// not subject to the autoplay policy that can silently block HTMLAudioElement
// playback inside an offscreen document, and an active context keeps the
// offscreen document alive while audio is playing.
function getAudioCtx(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext({ sampleRate: 24000 });
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

function startKeepAlive() {
  // The session AudioContext itself keeps the offscreen document alive; just
  // make sure it exists and is running.
  getAudioCtx();
}

async function checkModelCached(): Promise<boolean> {
  try {
    const cacheNames = await caches.keys();
    let totalKeys = 0;
    let hasModel = false;

    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      totalKeys += keys.length;
      if (cacheName.includes('transformers') || cacheName.includes('kokoro')) {
        hasModel ||= keys.some((request) => /kokoro|onnx-community/i.test(request.url));
      }
    }

    console.log(`[RA:offscreen] model cache status: ${hasModel ? 'CACHED' : 'NOT CACHED'}, ${totalKeys} total cached files`);
    return hasModel;
  } catch (error) {
    console.warn('[ReadAloud offscreen] model cache check failed', error);
    return false;
  }
}

function forwardProgress(progress: Partial<ProgressPayload>) {
  const percent = Math.round(progress.progress ?? 0);
  if (progress.status === 'progress' && percent - lastProgressPercent < 5) return;

  lastProgressPercent = percent;
  console.info('[ReadAloud offscreen] model progress', progress);
  chrome.runtime.sendMessage({
    type: 'MODEL_LOADING',
    payload: {
      loaded: progress.loaded ?? 0,
      total: progress.total ?? 0,
      modelName: progress.modelName ?? MODEL_NAME,
      file: progress.file,
      progress: progress.progress,
      status: progress.status
    }
  }).catch(() => undefined);
}

function sendError(message: string) {
  chrome.runtime.sendMessage({
    type: 'ERROR',
    payload: { message, recoverable: true }
  }).catch(() => undefined);
}

function cleanupReadAloudDomArtifacts(doc: Document) {
  doc.querySelectorAll('.ra-word').forEach((span) => {
    span.parentNode?.replaceChild(doc.createTextNode(span.textContent ?? ''), span);
  });
  doc.querySelectorAll('[data-readaloud-id]').forEach((el) => {
    el.removeAttribute('data-readaloud-id');
    if (el instanceof HTMLElement) delete el.dataset.readaloudId;
  });
}

function readSpeed(payload: unknown): number {
  const value = typeof payload === 'object' && payload && 'speed' in payload
    ? (payload as { speed: unknown }).speed
    : payload;
  return Number(value) || DEFAULT_SPEED;
}

function estimateWordTimings(text: string, durationMs: number): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || durationMs <= 0) return [];

  const totalChars = words.reduce((sum, word) => sum + word.length, 0) || words.length;
  const timings: WordTiming[] = [];
  let elapsed = 0;

  for (const word of words) {
    const wordDuration = (word.length / totalChars) * durationMs;
    timings.push({ word, startMs: elapsed, endMs: elapsed + wordDuration });
    elapsed += wordDuration;
  }

  return timings;
}

function startWordHighlighting(chunk: SynthesisedChunk) {
  stopWordHighlighting();
  if (!chunk.wordTimings.length || !audioCtx) return;

  let lastWordIndex = -1;
  wordHighlightTimer = globalThis.setInterval(() => {
    if (!audioCtx || audioCtx.state !== 'running' || !currentSource) return;

    // AudioContext.currentTime freezes while the context is suspended, so this
    // elapsed value naturally excludes paused time. Scale by playbackRate so
    // faster playback advances word timings to match.
    const elapsed = (audioCtx.currentTime - playbackStartCtxTime) * currentSpeed * 1000;
    let wordIndex = chunk.wordTimings.findIndex((timing) => elapsed >= timing.startMs && elapsed < timing.endMs);
    if (wordIndex < 0) wordIndex = chunk.wordTimings.length - 1;
    if (wordIndex === lastWordIndex) return;
    lastWordIndex = wordIndex;

    chrome.runtime.sendMessage({
      type: 'HIGHLIGHT_WORD',
      payload: {
        paragraphId: chunk.paragraphId,
        wordIndex: chunk.wordOffset + wordIndex,
        word: chunk.wordTimings[wordIndex].word
      }
    }).catch(() => undefined);
  }, 50);
}

function stopWordHighlighting() {
  if (wordHighlightTimer !== null) {
    clearInterval(wordHighlightTimer);
    wordHighlightTimer = null;
  }
}
