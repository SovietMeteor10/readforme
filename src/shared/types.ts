export type MessageType =
  | 'PLAY'
  | 'START_FROM_ACTION'
  | 'READ_FROM_SELECTION'
  | 'SEEK_TO_PARAGRAPH'
  | 'PAUSE'
  | 'RESUME'
  | 'STOP'
  | 'SET_SPEED'
  | 'SET_VOICE'
  | 'TTS_CHUNK'
  | 'TTS_BATCH'
  | 'TTS_ALL_CHUNKS'
  | 'CLASSIFY_CHUNKS'
  | 'AUDIO_READY'
  | 'CHUNK_DONE'
  | 'HIGHLIGHT'
  | 'HIGHLIGHT_WORD'
  | 'PLAYER_PROGRESS'
  | 'PLAYER_STATE'
  | 'PLAYBACK_COMPLETE'
  | 'EXTRACTION_STARTED'
  | 'EXTRACTION_DONE'
  | 'MODEL_LOADING'
  | 'MODEL_READY'
  | 'PREWARM'
  | 'PREWARM_OFFSCREEN'
  | 'PAUSE_OFFSCREEN'
  | 'RESUME_OFFSCREEN'
  | 'STOP_OFFSCREEN'
  | 'ERROR';

export interface Chunk {
  index: number;
  text: string;
  paragraphId: string;
  wordOffset?: number;
}

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload?: T;
}

export interface PlayPayload {
  chunks: Chunk[];
  voice: string;
  speed: number;
}

export interface TtsChunkPayload {
  chunk: Chunk;
  voice: string;
  speed: number;
}

export interface TtsBatchPayload {
  chunks: Chunk[];
  voice: string;
  speed: number;
  reset?: boolean;
  final?: boolean;
}

export interface ProgressPayload {
  loaded: number;
  total: number;
  modelName: string;
  file?: string;
  progress?: number;
  status?: string;
}

export interface HighlightPayload {
  paragraphId: string | null;
  index: number;
  total: number;
  chunkIndex?: number;
}

export interface ErrorPayload {
  message: string;
  recoverable?: boolean;
}
