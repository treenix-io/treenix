## mods/whisper
Audio transcription via @huggingface/transformers (Whisper). HTTP POST → node in tree immediately, transcribe in background.

### Файлы
- route.ts — createWhisperHandler(cfg): POST audio → create node with status '...', respond 200, transcribe async via ffmpeg+transformers.js, update node
- types.ts — WhisperAudio, WhisperText, WhisperMeta, WhisperChecklist component classes
- service.ts — service registration
- server.ts — mounts HTTP handler, tRPC routes
- client.ts — frontend API
- view.tsx — React UI

### Конвенции
- Pipeline: POST → ffmpeg → 16kHz mono WAV → Float32Array → Whisper pipeline
- Node appears in tree immediately (status '...'), updated when transcription finishes
- Models lazy-loaded and cached: `onnx-community/whisper-{model}` or full HF model id
- timeId() = YYYYMMDD-HHmmss-SSS for sortable node names
