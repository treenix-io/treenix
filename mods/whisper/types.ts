import { getComponent, type NodeData, register } from '@treenx/core';
import '@treenx/core/contexts/text';
import { registerType } from '@treenx/core/comp';

/** Speech-to-text config — Whisper model, language, audio path */
export class WhisperConfig {
  model = 'small';
  language = 'ru';
  audioDir = './data/audio';
  url = '';  // override route path; empty = use node's $path
  /** Channel id → target dir for transcription nodes. Route rejects ids not listed here (fail closed) */
  channels: Record<string, string> = {};
  /** Delete raw audio files older than this many days (0 = keep forever); transcript text stays */
  keepDays = 0;
}

/** Audio file metadata — filename, size, MIME type */
export class WhisperAudio {
  filename = '';
  size = 0;
  mime = 'audio/wav';
}

/** Transcription result — recognized text content */
export class WhisperText {
  /** @format textarea */
  content = '';
}

/** Transcription metadata — model, language, duration, segments */
export class WhisperMeta {
  model = '';
  language = '';
  duration = 0;
  segments = 0;
  transcribedAt = 0;
  /** Transcription failure — visible instead of a forever-'...' text */
  error = '';
}

/** Transcription node — content lives in #audio/#text/#meta components */
export class WhisperTranscription {}

/** Meeting checklist — action items from transcription */
export class WhisperChecklist {
  checked: string[] = [];
}

/** Whisper channel — container for audio transcriptions with an optional checklist */
export class WhisperChannel {
  checklist?: WhisperChecklist;
}

registerType('whisper.config', WhisperConfig);
registerType('whisper.audio', WhisperAudio);
registerType('whisper.text', WhisperText);
registerType('whisper.meta', WhisperMeta);
registerType('whisper.checklist', WhisperChecklist);
registerType('whisper.channel', WhisperChannel);
registerType('whisper.transcription', WhisperTranscription);

// 'text' context: readable content for consumers ('' = transcription pending).
// Registry erases types (system boundary) — data is the node.
register('whisper.transcription', 'text', (data) => {
  const node = data as NodeData;
  const text = getComponent(node, WhisperText);
  if (!text) throw new Error(`whisper.transcription without #text: ${node.$path}`);
  return text.content === '...' ? '' : text.content;
});
