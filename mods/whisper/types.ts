import { registerType } from '@treenx/core/comp';

/** Speech-to-text config — Whisper model, language, audio path */
export class WhisperConfig {
  model = 'small';
  language = 'ru';
  audioDir = './data/audio';
  url = '';  // override route path; empty = use node's $path
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
}

/** Meeting checklist — action items from transcription */
export class WhisperChecklist {
  checked: string[] = [];
}

/** Whisper channel — container for audio transcriptions with an optional checklist */
export class WhisperChannel {
  checklist?: WhisperChecklist;
}

/** Bridge: auto-send whisper transcriptions to a task inbox */
export class WhisperInbox {
  /** @format path @description Whisper channel to watch, e.g. /whisper/kriz */
  source = '';
  /** @format path @description Target inbox, e.g. /agent */
  target = '';
}

registerType('whisper.config', WhisperConfig);
registerType('whisper.audio', WhisperAudio);
registerType('whisper.text', WhisperText);
registerType('whisper.meta', WhisperMeta);
registerType('whisper.checklist', WhisperChecklist);
registerType('whisper.channel', WhisperChannel);
registerType('whisper.inbox', WhisperInbox);
