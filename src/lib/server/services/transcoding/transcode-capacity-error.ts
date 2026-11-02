// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thrown by `FFmpegTranscodeService.startJob` when the server-wide cap
 * (`LUMASTRA_MAX_CONCURRENT_TRANSCODES`) is reached and every job holding a
 * slot is still being watched, or the system-load breaker refuses admission.
 * The NEW stream is refused instead; callers answer 503
 * with `Retry-After` rather than a generic start failure. Lives in its own
 * module for the same reason as `PlaySessionOwnedByAnotherUserError`.
 */
export class TranscodeCapacityError extends Error {
    constructor(
        message: string,
        public readonly code: 'transcode_capacity' | 'transcode_load_shed' = 'transcode_capacity',
    ) {
        super(message);
        this.name = 'TranscodeCapacityError';
    }
}

/** Seconds a client should wait before retrying a capacity refusal. */
export const TRANSCODE_CAPACITY_RETRY_AFTER_SECONDS = 30;
