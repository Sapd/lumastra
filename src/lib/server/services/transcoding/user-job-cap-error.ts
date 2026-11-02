// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thrown by `FFmpegTranscodeService.startJob(…, { refuseAtUserCap: true })`
 * when the principal already holds `FFMPEG_MAX_JOBS_PER_USER` sessions. Lives
 * in its own module for the same reason as `PlaySessionOwnedByAnotherUserError`:
 * callers can `instanceof` it without importing the transcode service.
 */
export class UserJobCapReachedError extends Error {
    constructor(cap: number) {
        super(`Maximum ${cap} concurrent transcode jobs per user`);
        this.name = 'UserJobCapReachedError';
    }
}
