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
  audioUrl: string;
  wordTimings: WordTiming[];
  durationMs: number;
  wordOffset: number;
}

interface PendingChunk {
  result: SynthesisedChunk;
  audio: HTMLAudioElement;
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
let currentAudio: HTMLAudioElement | null = null;
let currentChunk: SynthesisedChunk | null = null;
let wordHighlightTimer: ReturnType<typeof globalThis.setInterval> | null = null;
let currentGen = 0;
let keepAliveAudio: HTMLAudioElement | null = null;
let keepAliveAudioUrl: string | null = null;
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

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse).catch((error) => {
    chrome.runtime.sendMessage({
      type: 'ERROR',
      payload: { message: error instanceof Error ? error.message : String(error), recoverable: true }
    });
    sendResponse({ ok: false });
  });
  return true;
});

async function handleMessage(message: ExtensionMessage) {
  switch (message.type) {
    case 'PREWARM_OFFSCREEN':
      console.info('[ReadAloud offscreen] prewarming Kokoro only');
      void getTTS().catch((error) => {
        console.warn('[ReadAloud offscreen] prewarm failed', error);
      });
      return { ok: true };
    case 'CLASSIFY_CHUNKS':
      return { ok: true, chunks: heuristicFilter(message.payload as Chunk[]) };
    case 'TTS_CHUNK': {
      const payload = message.payload as TtsChunkPayload;
      await startPlayback(payload.chunk ? [payload.chunk] : [], payload.voice, payload.speed);
      return { ok: true };
    }
    case 'TTS_BATCH': {
      const payload = message.payload as TtsBatchPayload;
      await startPlayback(payload.chunks ?? [], payload.voice, payload.speed);
      return { ok: true };
    }
    case 'TTS_ALL_CHUNKS': {
      const payload = message.payload as PlayPayload;
      await startPlayback(payload.chunks ?? [], payload.voice, payload.speed);
      return { ok: true };
    }
    case 'SET_SPEED':
      currentSpeed = readSpeed(message.payload);
      if (currentAudio) currentAudio.playbackRate = currentSpeed;
      if (pendingNext) pendingNext.audio.playbackRate = currentSpeed;
      return { ok: true };
    case 'PAUSE_OFFSCREEN':
      isPaused = true;
      isPlaying = false;
      currentAudio?.pause();
      stopWordHighlighting();
      return { ok: true };
    case 'RESUME_OFFSCREEN':
      isPaused = false;
      if (currentChunk && currentAudio && currentAudio.paused) {
        isPlaying = true;
        startWordHighlighting(currentChunk);
        await currentAudio.play().catch((error) => {
          console.warn('[ReadAloud offscreen] resume failed', error);
        });
      } else if (!currentAudio && pendingNext && waitingForNext) {
        advancePlayback(currentGen);
      }
      return { ok: true };
    case 'STOP_OFFSCREEN':
      stopCurrentPlayback();
      return { ok: true };
    default:
      return { ok: true };
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
    stopCurrentPlayback(false);
    startKeepAlive();

    playQueue = chunks;
    playHead = 0;
    currentVoice = voice || currentVoice || DEFAULT_VOICE;
    currentSpeed = speed || currentSpeed || DEFAULT_SPEED;
    pendingNext = null;
    pendingNextIdx = -1;

    chrome.runtime.sendMessage({
      type: 'PLAYER_STATE',
      payload: { state: 'preparing', total: chunks.length }
    }).catch(() => undefined);

    if (!chunks.length) {
      sendError('No chunks to play');
      stopKeepAlive();
      return;
    }

    try {
      await getTTS();
    } catch (error) {
      stopKeepAlive();
      sendError(`Failed to load voice model: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (gen !== currentGen) return;

    const firstPromise = synthesiseOne(chunks[0], gen);
    if (chunks.length > 1) fetchAndStage(1, gen);

    const first = await firstPromise;
    if (gen !== currentGen) return;
    if (!first) {
      stopCurrentPlayback();
      sendError('Synthesis failed');
      return;
    }

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
    if (!result || gen !== currentGen) {
      if (result) cleanupObjectUrl(result.audioUrl);
      return;
    }

    const audio = new Audio(result.audioUrl);
    audio.playbackRate = currentSpeed;
    audio.preload = 'auto';
    audio.load();
    pendingNext = { result, audio };
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
    playDirect(next.result, gen, next.audio);
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
  const audio = new Audio(result.audioUrl);
  audio.playbackRate = currentSpeed;
  playDirect(result, gen, audio);
}

function playDirect(result: SynthesisedChunk, gen: number, existingAudio?: HTMLAudioElement) {
  if (gen !== currentGen) {
    cleanupObjectUrl(result.audioUrl);
    return;
  }

  isPlaying = true;
  waitingForNext = false;
  currentChunk = result;
  currentAudio = existingAudio ?? new Audio(result.audioUrl);
  currentAudio.playbackRate = currentSpeed;

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

  startWordHighlighting(result);

  currentAudio.onended = () => {
    if (gen !== currentGen) return;
    isPlaying = false;
    stopWordHighlighting();
    cleanupObjectUrl(result.audioUrl);
    currentAudio = null;
    currentChunk = null;
    chrome.runtime.sendMessage({ type: 'CHUNK_DONE', payload: { chunkIndex: result.chunkIndex } }).catch(() => undefined);
    advancePlayback(gen);
  };

  currentAudio.onerror = (error) => {
    console.error('[ReadAloud offscreen] audio playback error', error);
    isPlaying = false;
    stopWordHighlighting();
    cleanupObjectUrl(result.audioUrl);
    currentAudio = null;
    currentChunk = null;
    chrome.runtime.sendMessage({ type: 'CHUNK_DONE', payload: { chunkIndex: result.chunkIndex } }).catch(() => undefined);
    advancePlayback(gen);
  };

  currentAudio.play().catch((error) => {
    console.error('[ReadAloud offscreen] play failed', error);
    isPlaying = false;
    stopWordHighlighting();
    cleanupObjectUrl(result.audioUrl);
    currentAudio = null;
    currentChunk = null;
    advancePlayback(gen);
  });
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
    const wavBlob = float32ToWav(samples, sampleRate);
    console.log(`[RA:tts] chunk ${chunk.index} ready: ${(durationMs / 1000).toFixed(1)}s`);

    return {
      chunkIndex: chunk.index,
      paragraphId: chunk.paragraphId,
      text,
      audioUrl: URL.createObjectURL(wavBlob),
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
  stopKeepAlive();
  isPaused = false;
  isPlaying = false;
  isFetching = false;
  waitingForNext = false;

  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.removeAttribute('src');
    currentAudio.load();
    currentAudio = null;
  }

  if (currentChunk) {
    cleanupObjectUrl(currentChunk.audioUrl);
    currentChunk = null;
  }

  if (pendingNext) {
    pendingNext.audio.onended = null;
    pendingNext.audio.onerror = null;
    pendingNext.audio.pause();
    pendingNext.audio.removeAttribute('src');
    pendingNext.audio.load();
    cleanupObjectUrl(pendingNext.result.audioUrl);
    pendingNext = null;
  }
  pendingNextIdx = -1;

  playQueue = [];
  playHead = 0;
  stopWordHighlighting();
}

function completePlayback(gen: number) {
  if (gen !== currentGen) return;
  stopKeepAlive();
  chrome.runtime.sendMessage({ type: 'PLAYBACK_COMPLETE' }).catch(() => undefined);
}

function startKeepAlive() {
  if (keepAliveAudio) return;

  try {
    const sampleRate = 24000;
    const wavBlob = float32ToWav(new Float32Array(sampleRate), sampleRate);
    keepAliveAudioUrl = URL.createObjectURL(wavBlob);
    keepAliveAudio = new Audio(keepAliveAudioUrl);
    keepAliveAudio.loop = true;
    keepAliveAudio.volume = 0.001;
    keepAliveAudio.play().catch((error) => {
      console.warn('[ReadAloud offscreen] keepalive audio failed', error instanceof Error ? error.message : error);
      stopKeepAlive();
    });
  } catch (error) {
    console.warn('[ReadAloud offscreen] keepalive setup failed', error);
  }
}

function stopKeepAlive() {
  if (!keepAliveAudio) return;
  keepAliveAudio.pause();
  keepAliveAudio.removeAttribute('src');
  keepAliveAudio.load();
  keepAliveAudio = null;
  if (keepAliveAudioUrl) {
    cleanupObjectUrl(keepAliveAudioUrl);
    keepAliveAudioUrl = null;
  }
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

function cleanupObjectUrl(url: string) {
  URL.revokeObjectURL(url);
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
  if (!chunk.wordTimings.length || !currentAudio) return;

  let lastWordIndex = -1;
  wordHighlightTimer = globalThis.setInterval(() => {
    if (!currentAudio || currentAudio.paused) return;

    const elapsed = currentAudio.currentTime * 1000;
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

function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
