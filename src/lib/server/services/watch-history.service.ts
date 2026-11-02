// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';
import type { UserId } from '$lib/shared/user-id';
import {
    insertWatchHistoryFromSession,
    type InsertWatchHistoryParams,
} from '$lib/server/database/queries/watch-history-insert.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import type postgres from 'postgres';

const logger = Logger.for('WatchHistoryService');

export interface CompletedSessionData {
    userId: UserId;
    mediaId: string;
    mediaType: string;
    title: string;
    year?: number;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    startedAt: Date;
    stoppedAt: Date;
    positionMs: number;
    runtimeMs?: number;
    isCompleted: boolean;
    deviceName?: string;
    clientName?: string;
    playMethod?: string;
    videoCodec?: string;
    resolution?: string;
    bitrateKbps?: number;
    playSessionId?: string;
}

export class WatchHistoryService {
    constructor(
        private getDbFn: () => postgres.Sql | null = getDb,
        private insertFn: typeof insertWatchHistoryFromSession = insertWatchHistoryFromSession,
    ) {}

    async recordCompletedSession(data: CompletedSessionData, txSql?: postgres.Sql): Promise<void> {
        const sql = txSql ?? this.getDbFn();
        if (!sql) return;

        // Wall clock from start to stop, which counts pauses and a player left
        // open — capped at the title's runtime when known, since one sitting
        // cannot plausibly watch more than the whole title (prod: a 55-minute
        // episode recorded as 5 h 38 m with the playhead at 0). Personal stats
        // apply the same cap to rows recorded before this.
        const durationMs = Math.max(0, data.stoppedAt.getTime() - data.startedAt.getTime());
        const wallClockSeconds = Math.round(durationMs / 1000);
        const actualWatchTimeSeconds =
            data.runtimeMs && data.runtimeMs > 0
                ? Math.min(wallClockSeconds, Math.round(data.runtimeMs / 1000))
                : wallClockSeconds;
        const maxPositionSeconds = Math.round(data.positionMs / 1000);
        const totalRuntimeSeconds = data.runtimeMs ? Math.round(data.runtimeMs / 1000) : undefined;
        const completionPercentage =
            data.runtimeMs && data.runtimeMs > 0
                ? Math.min(Math.round((data.positionMs / data.runtimeMs) * 100), 100)
                : 0;

        const params: InsertWatchHistoryParams = {
            userId: data.userId,
            mediaId: data.mediaId,
            mediaType: data.mediaType,
            title: data.title,
            year: data.year,
            seriesName: data.seriesName,
            seasonNumber: data.seasonNumber,
            episodeNumber: data.episodeNumber,
            sessionStartTime: data.startedAt,
            sessionEndTime: data.stoppedAt,
            actualWatchTimeSeconds,
            maxPositionSeconds,
            totalRuntimeSeconds,
            completionPercentage,
            isCompleted: data.isCompleted,
            deviceName: data.deviceName,
            clientName: data.clientName,
            playMethod: data.playMethod,
            videoCodec: data.videoCodec,
            resolution: data.resolution,
            bitrateKbps: data.bitrateKbps,
            sourcePlaySessionId: data.playSessionId,
            sourceService: 'lumastra',
        };

        try {
            await this.insertFn(sql, params);
            logger.debug('Recorded watch_history entry', {
                userId: data.userId,
                mediaId: data.mediaId,
                completed: data.isCompleted,
            });
        } catch (err) {
            // Escalate to ERROR with a structured tag — watch_history is
            // the canonical user-data write. Silent failure here causes
            // permanent data loss for that user (missing rows feed
            // For-You, personal stats, recently-watched). Operators must
            // see this in alerting, not buried in warn-volume noise.
            logger.error(
                'WATCH_HISTORY_WRITE_FAILED: insert into watch_history threw',
                err instanceof Error ? err : new Error(String(err)),
                {
                    tag: 'WATCH_HISTORY_WRITE_FAILED',
                    userId: data.userId,
                    mediaId: data.mediaId,
                    playSessionId: data.playSessionId,
                    isCompleted: data.isCompleted,
                },
            );
        }
    }
}

export const watchHistoryService = new WatchHistoryService();
