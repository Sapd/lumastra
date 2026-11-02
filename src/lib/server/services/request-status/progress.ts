// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Download progress extraction from Sonarr/Radarr queues
 */

import type {
    SonarrQueueResponse,
    RadarrQueueResponse,
    SonarrQueueRecord,
    RadarrQueueRecord,
} from '$lib/server/sonarr.js';
import type { DownloadProgress } from './types.js';

/**
 * Format bytes to a human-readable size string, scaling the unit so small
 * files don't collapse to "0.0 GB". Picks MB / GB / TB based on magnitude.
 */
function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 MB';
    const mb = bytes / 1024 / 1024;
    if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    const gb = mb / 1024;
    if (gb < 1024) return `${gb.toFixed(1)} GB`;
    const tb = gb / 1024;
    return `${tb.toFixed(2)} TB`;
}

/**
 * Compute a download percentage that never reports 100% until the download is
 * truly complete (sizeleft === 0). Floors the value and clamps to 99 while any
 * bytes remain, so the ">=100 importing" heuristic isn't tripped early by
 * rounding.
 */
function computePercentage(totalSize: number, remaining: number): number {
    if (totalSize <= 0) return 0;
    if (remaining <= 0) return 100;
    const pct = Math.floor(((totalSize - remaining) / totalSize) * 100);
    return Math.min(99, Math.max(0, pct));
}

/**
 * Parse an *arr timeleft string into seconds. Sonarr/Radarr may day-prefix the
 * value as `d.hh:mm:ss` (e.g. `1.02:03:04`) in addition to plain `hh:mm:ss`.
 * Returns null for missing/zero/unknown values.
 */
function parseArrTimeleftToSeconds(timeleft: string | undefined): number | null {
    if (!timeleft || timeleft === 'unknown' || timeleft === '00:00:00') return null;
    // Split off an optional leading day component: "1.02:03:04" -> days=1, "02:03:04"
    let days = 0;
    let clock = timeleft;
    const dotIdx = timeleft.indexOf('.');
    // Only treat the dot as a day separator if it precedes an hh:mm:ss block.
    if (dotIdx > 0 && timeleft.includes(':')) {
        const maybeDays = Number(timeleft.slice(0, dotIdx));
        if (Number.isFinite(maybeDays)) {
            days = maybeDays;
            clock = timeleft.slice(dotIdx + 1);
        }
    }
    const parts = clock.split(':').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return null;
    let h = 0,
        m = 0;
    let s: number;
    if (parts.length === 3) [h, m, s] = parts;
    else if (parts.length === 2) [m, s] = parts;
    else if (parts.length === 1) [s] = parts;
    else return null;
    return days * 86400 + h * 3600 + m * 60 + s;
}

/**
 * Pick the longest (max) timeleft among downloading records so the displayed
 * ETA reflects the slowest episode rather than an arbitrary first one.
 */
function maxTimeLeft(records: Array<{ timeleft?: string }>): string | undefined {
    let best: { seconds: number; raw: string } | undefined;
    for (const r of records) {
        const seconds = parseArrTimeleftToSeconds(r.timeleft);
        if (seconds === null) continue;
        if (!best || seconds > best.seconds) {
            best = { seconds, raw: r.timeleft as string };
        }
    }
    return best?.raw;
}

/**
 * Get season download progress from Sonarr queue
 */
export function getSeasonProgressFromSonarr(
    tvdbId: number,
    seasonNumber: number,
    sonarrQueue: SonarrQueueResponse,
): DownloadProgress | null {
    // Find all episodes for this season in the queue
    const seasonEpisodes = sonarrQueue.records.filter(
        (record) =>
            record.series?.tvdbId === tvdbId && record.episode?.seasonNumber === seasonNumber,
    );

    if (seasonEpisodes.length === 0) return null;

    return buildSonarrProgress(seasonEpisodes);
}

/**
 * Shared aggregation for a set of Sonarr queue records (season or full series).
 * Returns a DownloadProgress even when totalSize is still 0 (freshly grabbed,
 * not yet sized) — null is reserved for "no record in queue".
 */
function buildSonarrProgress(records: SonarrQueueRecord[]): DownloadProgress {
    // Aggregate progress across all episodes
    const totalSize = records.reduce((sum, ep) => sum + (ep.size || 0), 0);
    const remaining = records.reduce((sum, ep) => sum + (ep.sizeleft || 0), 0);

    const percentage = computePercentage(totalSize, remaining);

    // Check if any episode is paused
    const hasPaused = records.some((ep) => ep.status?.toLowerCase() === 'paused');

    // Check if all are queued (waiting to start). When totalSize is still 0
    // (not yet sized), sizeleft === size holds trivially, so this also covers
    // the freshly-grabbed case.
    const allQueued = records.every(
        (ep) => ep.status?.toLowerCase() === 'queued' || ep.sizeleft === ep.size,
    );

    // ETA: longest remaining time among downloading episodes (not arbitrary first)
    const downloadingEpisodes = records.filter((ep) => ep.status?.toLowerCase() !== 'paused');
    const timeLeft = maxTimeLeft(downloadingEpisodes);

    // A season is importing only after every queued episode has finished
    // downloading. One importing episode must not hide the remaining downloads.
    const allCompleted = records.every(
        (ep) =>
            ep.trackedDownloadState === 'importPending' ||
            ep.trackedDownloadState === 'importing' ||
            (ep.size > 0 && ep.sizeleft === 0),
    );
    const isImporting = allCompleted && !hasPaused;

    // Determine state from queue status
    const state: DownloadProgress['state'] = hasPaused
        ? 'paused'
        : allQueued
          ? 'queued'
          : isImporting
            ? 'importing'
            : 'downloading';

    return {
        percentage,
        timeLeft,
        size: formatBytes(totalSize),
        sizeLeft: formatBytes(remaining),
        state,
    };
}

/**
 * Get aggregate TV show download progress from Sonarr queue
 * Uses TVDB ID to match series reliably (100% accuracy)
 * Returns progress across all episodes currently downloading
 */
export function getTvProgressFromSonarr(
    tvdbId: number,
    sonarrQueue: SonarrQueueResponse,
): DownloadProgress | null {
    // Find all episodes for this series in the queue
    const seriesEpisodes = sonarrQueue.records.filter((record) => record.series?.tvdbId === tvdbId);

    if (seriesEpisodes.length === 0) return null;

    return buildSonarrProgress(seriesEpisodes);
}

/**
 * Get movie download progress from Radarr queue
 * Uses TMDB ID to match movie reliably (99% accuracy)
 */
export function getMovieProgressFromRadarr(
    tmdbId: number,
    radarrQueue: RadarrQueueResponse,
): DownloadProgress | null {
    // Aggregate ALL records for this movie. A movie can have multiple queue
    // records (e.g. a failed grab being retried alongside a new release), so
    // using only the first via .find() understates the real progress.
    const movieRecords: RadarrQueueRecord[] = radarrQueue.records.filter(
        (record) => record.movie?.tmdbId === tmdbId,
    );

    if (movieRecords.length === 0) return null;

    const totalSize = movieRecords.reduce((sum, r) => sum + (r.size || 0), 0);
    const remaining = movieRecords.reduce((sum, r) => sum + (r.sizeleft || 0), 0);

    const percentage = computePercentage(totalSize, remaining);

    // Check status
    const isPaused = movieRecords.some((r) => r.status?.toLowerCase() === 'paused');
    const isQueued =
        !isPaused &&
        movieRecords.every((r) => r.status?.toLowerCase() === 'queued' || r.sizeleft === r.size);
    const hasImporting = movieRecords.some(
        (r) => r.trackedDownloadState === 'importPending' || r.trackedDownloadState === 'importing',
    );
    const isImporting = hasImporting || (remaining === 0 && totalSize > 0 && !isPaused);

    // Determine state from queue status
    const state: DownloadProgress['state'] = isPaused
        ? 'paused'
        : isQueued
          ? 'queued'
          : isImporting
            ? 'importing'
            : 'downloading';

    return {
        percentage,
        timeLeft: maxTimeLeft(movieRecords.filter((r) => r.status?.toLowerCase() !== 'paused')),
        size: formatBytes(totalSize),
        sizeLeft: formatBytes(remaining),
        state,
    };
}
