// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaySessionTranscodeCleanup');

/** Release a terminal session's job, including jobs owned by another pod. */
export async function stopSessionTranscode(sessionId: string, reason: string): Promise<void> {
    try {
        const { getFFmpegTranscodeService } = await import('./ffmpeg-transcode.service.js');
        // stopJob persists a non-restorable stop and broadcasts it to the owner.
        // Its database mark also covers a missed/unavailable pub/sub delivery.
        await getFFmpegTranscodeService().stopJob(sessionId, reason);
    } catch (error) {
        logger.warn('Failed to stop terminal session transcode', { sessionId, reason, error });
    }
}
