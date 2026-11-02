// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export {
    MusicTranscodeService,
    getMusicTranscodeService,
    _resetServiceForTests,
} from './service.js';
export type {
    TranscodeStreamRequest,
    TranscodeStreamResult,
    SessionContext,
    MusicCodec,
} from './types.js';
export { computeCacheKey } from './cache-key.js';
export { clampBitrate, defaultBitrateFor } from './bitrate-clamp.js';
export { signTranscodeToken, verifyTranscodeToken } from './token.js';
export { decide as decideTranscode } from './decision.js';
export { probeAudioSource } from './source-metadata.js';
export { PlaylistSourceRefusedError } from './source-guard.js';
export { containerFor, mimeFor } from './ffmpeg-args.js';
