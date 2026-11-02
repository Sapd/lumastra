// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thrown by `FFmpegTranscodeService.startJob(…, { requireSameOwner: true })`
 * when the PlaySessionId already has a resident job started by a different
 * user. Lives in its own module so callers can `instanceof` it without
 * importing the transcode service (whose module several test files replace
 * with a partial `vi.mock` factory).
 */
export class PlaySessionOwnedByAnotherUserError extends Error {
    constructor(playSessionId: string) {
        super(`PlaySessionId ${playSessionId.slice(0, 8)} is owned by another user`);
        this.name = 'PlaySessionOwnedByAnotherUserError';
    }
}
