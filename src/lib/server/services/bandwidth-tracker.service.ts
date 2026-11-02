// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bandwidth Tracker Service
 *
 * Tracks outgoing media bandwidth at the application level.
 * Counts bytes sent for HLS segments, proxied streams, etc.
 * Maintains a rolling history for the last hour.
 */

import { hostname } from 'node:os';
import { cacheSet, cacheGet, getKeysByPattern } from '$lib/server/cache/valkey.js';

interface BandwidthStats {
    totalBytes: number;
    timestamp: number;
}

interface BandwidthCategories {
    hlsSegments: BandwidthStats;
    directPlay: BandwidthStats;
    liveTV: BandwidthStats;
    proxiedStreams: BandwidthStats;
    images: BandwidthStats;
    subtitles: BandwidthStats;
    trickplay: BandwidthStats;
}

export interface BandwidthMetrics {
    hlsSegmentsBytesPerSec: number;
    directPlayBytesPerSec: number;
    liveTVBytesPerSec: number;
    proxiedStreamsBytesPerSec: number;
    imagesBytesPerSec: number;
    subtitlesBytesPerSec: number;
    trickplayBytesPerSec: number;
    totalBytesPerSec: number;
    hlsSegmentsMbps: number;
    directPlayMbps: number;
    liveTVMbps: number;
    proxiedStreamsMbps: number;
    imagesMbps: number;
    subtitlesMbps: number;
    trickplayMbps: number;
    totalMbps: number;
}

export interface BandwidthHistoryPoint {
    timestamp: number;
    hlsSegmentsMbps: number;
    directPlayMbps: number;
    liveTVMbps: number;
    proxiedStreamsMbps: number;
    imagesMbps: number;
    subtitlesMbps: number;
    trickplayMbps: number;
    totalMbps: number;
    hlsSegmentsPeakMbps: number;
    directPlayPeakMbps: number;
    liveTVPeakMbps: number;
    proxiedStreamsPeakMbps: number;
    imagesPeakMbps: number;
    subtitlesPeakMbps: number;
    trickplayPeakMbps: number;
    totalPeakMbps: number;
}

type CategoryKey = keyof BandwidthCategories;

const SESSION_BANDWIDTH_KEY_PREFIX = 'bandwidth:sessions:v1:';
/** Publish cadence; well inside the 10 s sliding window the rates describe. */
const SESSION_BANDWIDTH_PUBLISH_MS = 5_000;
/** A pod that stops publishing (crash, redeploy) drops out after this. */
const SESSION_BANDWIDTH_TTL_SEC = 15;

class BandwidthTrackerService {
    private stats: BandwidthCategories = {
        hlsSegments: { totalBytes: 0, timestamp: Date.now() },
        directPlay: { totalBytes: 0, timestamp: Date.now() },
        liveTV: { totalBytes: 0, timestamp: Date.now() },
        proxiedStreams: { totalBytes: 0, timestamp: Date.now() },
        images: { totalBytes: 0, timestamp: Date.now() },
        subtitles: { totalBytes: 0, timestamp: Date.now() },
        trickplay: { totalBytes: 0, timestamp: Date.now() },
    };

    private peakRates = {
        hlsSegmentsMbps: 0,
        directPlayMbps: 0,
        liveTVMbps: 0,
        proxiedStreamsMbps: 0,
        imagesMbps: 0,
        subtitlesMbps: 0,
        trickplayMbps: 0,
        totalMbps: 0,
    };

    // Per-session bandwidth tracking — sliding window of timestamped byte samples
    private static readonly SESSION_WINDOW_MS = 10_000; // 10-second sliding window
    private sessionSamples = new Map<string, { ts: number; bytes: number }[]>();

    // Rolling history for the last hour (one data point per minute)
    private history: BandwidthHistoryPoint[] = [];
    private readonly MAX_HISTORY_POINTS = 60; // 60 minutes
    private readonly HISTORY_INTERVAL_MS = 60_000; // 1 minute

    private track(category: CategoryKey, bytes: number): void {
        if (bytes > 0) this.stats[category].totalBytes += bytes;
    }

    /** Track bytes sent for a specific play session */
    trackSession(sessionId: string, bytes: number): void {
        if (bytes <= 0) return;
        let samples = this.sessionSamples.get(sessionId);
        if (!samples) {
            samples = [];
            this.sessionSamples.set(sessionId, samples);
        }
        samples.push({ ts: Date.now(), bytes });
    }

    /** Get current bandwidth in Mbps for all tracked sessions (10s sliding window) */
    getSessionBandwidthMap(): Map<string, number> {
        const now = Date.now();
        const cutoff = now - BandwidthTrackerService.SESSION_WINDOW_MS;
        const result = new Map<string, number>();
        for (const [sessionId, samples] of this.sessionSamples) {
            // Prune old samples
            while (samples.length > 0 && samples[0].ts < cutoff) {
                samples.shift();
            }
            if (samples.length === 0) {
                this.sessionSamples.delete(sessionId);
                continue;
            }
            const totalBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
            const windowSec = BandwidthTrackerService.SESSION_WINDOW_MS / 1000;
            result.set(sessionId, (totalBytes * 8) / 1_000_000 / windowSec);
        }
        return result;
    }

    /** Track bytes sent for HLS transcoded/remuxed segments */
    trackHlsSegment(bytes: number): void {
        this.track('hlsSegments', bytes);
    }

    /**
     * Per-session Mbps across every pod. The in-process map only sees the
     * bytes THIS pod served; with two web replicas behind the proxy the admin
     * request and the segment requests routinely land on different pods, so
     * the local map alone reads 0 for sessions that are streaming fine. Each
     * pod publishes its map (publishSessionBandwidth), and this merges the
     * others' snapshots with the live local map. A session split across pods
     * sums, which is the truth: both pods are sending it bytes.
     */
    async getAggregatedSessionBandwidthMap(): Promise<Map<string, number>> {
        const result = this.getSessionBandwidthMap();
        const ownKey = SESSION_BANDWIDTH_KEY_PREFIX + hostname();
        const keys = (
            await getKeysByPattern(SESSION_BANDWIDTH_KEY_PREFIX + '*').catch((): string[] => [])
        ).filter((k) => k !== ownKey);
        if (keys.length === 0) return result;
        const snapshots = await Promise.all(
            keys.map((k) => cacheGet(k).catch((): string | null => null)),
        );
        for (const raw of snapshots) {
            if (!raw) continue;
            try {
                const entries = JSON.parse(raw) as Record<string, number>;
                for (const [sessionId, mbps] of Object.entries(entries)) {
                    if (typeof mbps !== 'number' || !(mbps > 0)) continue;
                    result.set(sessionId, (result.get(sessionId) ?? 0) + mbps);
                }
            } catch {
                // skip malformed entries
            }
        }
        return result;
    }

    private publishedNonEmpty = false;

    /**
     * Write this pod's per-session map to Valkey for the other pods to read.
     * Skips the write while idle, except once to clear a map it published
     * before, so an idle install costs no Valkey traffic.
     */
    publishSessionBandwidth(): void {
        const map = this.getSessionBandwidthMap();
        if (map.size === 0 && !this.publishedNonEmpty) return;
        this.publishedNonEmpty = map.size > 0;
        cacheSet(
            SESSION_BANDWIDTH_KEY_PREFIX + hostname(),
            JSON.stringify(Object.fromEntries(map)),
            SESSION_BANDWIDTH_TTL_SEC,
        ).catch(() => undefined);
    }

    /** Track HLS segment bytes for both the aggregate category and a specific session */
    trackHlsSegmentForSession(sessionId: string, bytes: number): void {
        this.trackHlsSegment(bytes);
        this.trackSession(sessionId, bytes);
    }

    /** Track bytes sent for direct file play */
    trackDirectPlay(bytes: number): void {
        this.track('directPlay', bytes);
    }

    /** Track bytes sent for LiveTV streams */
    trackLiveTV(bytes: number): void {
        this.track('liveTV', bytes);
    }

    /** Track bytes sent for Jellyfin-proxied streams */
    trackProxiedStream(bytes: number): void {
        this.track('proxiedStreams', bytes);
    }

    /** Track bytes sent for images (posters, backdrops, avatars) */
    trackImage(bytes: number): void {
        this.track('images', bytes);
    }

    /** Track bytes sent for subtitle files */
    trackSubtitle(bytes: number): void {
        this.track('subtitles', bytes);
    }

    /** Track bytes sent for trickplay thumbnail tiles */
    trackTrickplay(bytes: number): void {
        this.track('trickplay', bytes);
    }

    private rate(cat: CategoryKey, now: number): number {
        const elapsed = (now - this.stats[cat].timestamp) / 1000;
        return elapsed >= 1 ? this.stats[cat].totalBytes / elapsed : 0;
    }

    /**
     * Get current bandwidth metrics (bytes/sec and Mbps)
     */
    getMetrics(): BandwidthMetrics | null {
        const now = Date.now();

        const allKeys: CategoryKey[] = [
            'hlsSegments',
            'directPlay',
            'liveTV',
            'proxiedStreams',
            'images',
            'subtitles',
            'trickplay',
        ];
        const anyReady = allKeys.some((k) => (now - this.stats[k].timestamp) / 1000 >= 1);
        if (!anyReady) return null;

        const toMbps = (bps: number) => (bps * 8) / 1_000_000;
        const r = (k: CategoryKey) => this.rate(k, now);

        const hlsBps = r('hlsSegments');
        const directBps = r('directPlay');
        const liveBps = r('liveTV');
        const proxiedBps = r('proxiedStreams');
        const imgBps = r('images');
        const subBps = r('subtitles');
        const trickBps = r('trickplay');
        const totalBps = hlsBps + directBps + liveBps + proxiedBps + imgBps + subBps + trickBps;

        const hlsMbps = toMbps(hlsBps);
        const directMbps = toMbps(directBps);
        const liveMbps = toMbps(liveBps);
        const proxiedMbps = toMbps(proxiedBps);
        const imgMbps = toMbps(imgBps);
        const subMbps = toMbps(subBps);
        const trickMbps = toMbps(trickBps);
        const totalMbps = toMbps(totalBps);

        // Update peak tracking
        if (hlsMbps > this.peakRates.hlsSegmentsMbps) this.peakRates.hlsSegmentsMbps = hlsMbps;
        if (directMbps > this.peakRates.directPlayMbps) this.peakRates.directPlayMbps = directMbps;
        if (liveMbps > this.peakRates.liveTVMbps) this.peakRates.liveTVMbps = liveMbps;
        if (proxiedMbps > this.peakRates.proxiedStreamsMbps)
            this.peakRates.proxiedStreamsMbps = proxiedMbps;
        if (imgMbps > this.peakRates.imagesMbps) this.peakRates.imagesMbps = imgMbps;
        if (subMbps > this.peakRates.subtitlesMbps) this.peakRates.subtitlesMbps = subMbps;
        if (trickMbps > this.peakRates.trickplayMbps) this.peakRates.trickplayMbps = trickMbps;
        if (totalMbps > this.peakRates.totalMbps) this.peakRates.totalMbps = totalMbps;

        return {
            hlsSegmentsBytesPerSec: hlsBps,
            directPlayBytesPerSec: directBps,
            liveTVBytesPerSec: liveBps,
            proxiedStreamsBytesPerSec: proxiedBps,
            imagesBytesPerSec: imgBps,
            subtitlesBytesPerSec: subBps,
            trickplayBytesPerSec: trickBps,
            totalBytesPerSec: totalBps,
            hlsSegmentsMbps: hlsMbps,
            directPlayMbps: directMbps,
            liveTVMbps: liveMbps,
            proxiedStreamsMbps: proxiedMbps,
            imagesMbps: imgMbps,
            subtitlesMbps: subMbps,
            trickplayMbps: trickMbps,
            totalMbps,
        };
    }

    /**
     * Reset counters and timestamps.
     * Also records current metrics to in-memory history and writes to Valkey.
     */
    reset(): void {
        const metrics = this.getMetrics();
        if (metrics) {
            const point: BandwidthHistoryPoint = {
                timestamp: Date.now(),
                hlsSegmentsMbps: metrics.hlsSegmentsMbps,
                directPlayMbps: metrics.directPlayMbps,
                liveTVMbps: metrics.liveTVMbps,
                proxiedStreamsMbps: metrics.proxiedStreamsMbps,
                imagesMbps: metrics.imagesMbps,
                subtitlesMbps: metrics.subtitlesMbps,
                trickplayMbps: metrics.trickplayMbps,
                totalMbps: metrics.totalMbps,
                hlsSegmentsPeakMbps: this.peakRates.hlsSegmentsMbps,
                directPlayPeakMbps: this.peakRates.directPlayMbps,
                liveTVPeakMbps: this.peakRates.liveTVMbps,
                proxiedStreamsPeakMbps: this.peakRates.proxiedStreamsMbps,
                imagesPeakMbps: this.peakRates.imagesMbps,
                subtitlesPeakMbps: this.peakRates.subtitlesMbps,
                trickplayPeakMbps: this.peakRates.trickplayMbps,
                totalPeakMbps: this.peakRates.totalMbps,
            };
            this.recordHistoryPoint(point);

            // Write to Valkey for cross-pod aggregation (fire-and-forget)
            const podName = hostname();
            const timestamp = point.timestamp;
            cacheSet('bandwidth:pod:v1:' + podName, JSON.stringify(metrics), 90).catch(
                () => undefined,
            );
            cacheSet(
                'bandwidth:history:v1:' + podName + ':' + timestamp,
                JSON.stringify(point),
                3900, // 65 minutes TTL, auto-expires
            ).catch(() => undefined);
        }

        const now = Date.now();
        const zero = { totalBytes: 0, timestamp: now };
        this.stats = {
            hlsSegments: { ...zero },
            directPlay: { ...zero },
            liveTV: { ...zero },
            proxiedStreams: { ...zero },
            images: { ...zero },
            subtitles: { ...zero },
            trickplay: { ...zero },
        };
        this.peakRates = {
            hlsSegmentsMbps: 0,
            directPlayMbps: 0,
            liveTVMbps: 0,
            proxiedStreamsMbps: 0,
            imagesMbps: 0,
            subtitlesMbps: 0,
            trickplayMbps: 0,
            totalMbps: 0,
        };
        // Session samples use a self-cleaning sliding window — no reset needed
    }

    /**
     * Record a history point and maintain rolling window
     */
    private recordHistoryPoint(point: BandwidthHistoryPoint): void {
        this.history.push(point);

        // Remove old points (keep last hour only)
        const cutoffTime = Date.now() - this.HISTORY_INTERVAL_MS * this.MAX_HISTORY_POINTS;
        this.history = this.history.filter((p) => p.timestamp >= cutoffTime);
    }

    /**
     * Get bandwidth history for the last hour (in-memory, this pod only)
     */
    getHistory(): BandwidthHistoryPoint[] {
        return [...this.history];
    }

    /**
     * Get aggregated bandwidth metrics across all pods from Valkey.
     * Returns null if no pod data is available.
     */
    async getAggregatedMetrics(): Promise<BandwidthMetrics | null> {
        const keys = await getKeysByPattern('bandwidth:pod:v1:*');
        if (keys.length === 0) return null;

        const results = await Promise.all(keys.map((k) => cacheGet(k)));

        let found = false;
        const agg: BandwidthMetrics = {
            hlsSegmentsBytesPerSec: 0,
            directPlayBytesPerSec: 0,
            liveTVBytesPerSec: 0,
            proxiedStreamsBytesPerSec: 0,
            imagesBytesPerSec: 0,
            subtitlesBytesPerSec: 0,
            trickplayBytesPerSec: 0,
            totalBytesPerSec: 0,
            hlsSegmentsMbps: 0,
            directPlayMbps: 0,
            liveTVMbps: 0,
            proxiedStreamsMbps: 0,
            imagesMbps: 0,
            subtitlesMbps: 0,
            trickplayMbps: 0,
            totalMbps: 0,
        };

        for (const raw of results) {
            if (!raw) continue;
            try {
                const m = JSON.parse(raw) as BandwidthMetrics;
                agg.hlsSegmentsBytesPerSec += m.hlsSegmentsBytesPerSec ?? 0;
                agg.directPlayBytesPerSec += m.directPlayBytesPerSec ?? 0;
                agg.liveTVBytesPerSec += m.liveTVBytesPerSec ?? 0;
                agg.proxiedStreamsBytesPerSec += m.proxiedStreamsBytesPerSec ?? 0;
                agg.imagesBytesPerSec += m.imagesBytesPerSec ?? 0;
                agg.subtitlesBytesPerSec += m.subtitlesBytesPerSec ?? 0;
                agg.trickplayBytesPerSec += m.trickplayBytesPerSec ?? 0;
                agg.totalBytesPerSec += m.totalBytesPerSec ?? 0;
                agg.hlsSegmentsMbps += m.hlsSegmentsMbps ?? 0;
                agg.directPlayMbps += m.directPlayMbps ?? 0;
                agg.liveTVMbps += m.liveTVMbps ?? 0;
                agg.proxiedStreamsMbps += m.proxiedStreamsMbps ?? 0;
                agg.imagesMbps += m.imagesMbps ?? 0;
                agg.subtitlesMbps += m.subtitlesMbps ?? 0;
                agg.trickplayMbps += m.trickplayMbps ?? 0;
                agg.totalMbps += m.totalMbps ?? 0;
                found = true;
            } catch {
                // skip malformed entries
            }
        }

        return found ? agg : null;
    }

    /**
     * Get aggregated bandwidth history across all pods from Valkey.
     * Groups by timestamp (rounded to nearest 60s), sums across pods, returns last 60 points.
     */
    async getAggregatedHistory(): Promise<BandwidthHistoryPoint[]> {
        const keys = await getKeysByPattern('bandwidth:history:v1:*', 5000);
        if (keys.length === 0) return [];

        const results = await Promise.all(keys.map((k) => cacheGet(k)));

        // Group by timestamp rounded to nearest 60s, sum values across pods
        const grouped = new Map<number, BandwidthHistoryPoint>();

        for (const raw of results) {
            if (!raw) continue;
            try {
                const p = JSON.parse(raw) as BandwidthHistoryPoint;
                const bucket = Math.round(p.timestamp / 60_000) * 60_000;

                const existing = grouped.get(bucket);
                if (!existing) {
                    // Coalesce all fields to 0 — old pods may omit newer fields
                    grouped.set(bucket, {
                        timestamp: bucket,
                        hlsSegmentsMbps: p.hlsSegmentsMbps ?? 0,
                        directPlayMbps: p.directPlayMbps ?? 0,
                        liveTVMbps: p.liveTVMbps ?? 0,
                        proxiedStreamsMbps: p.proxiedStreamsMbps ?? 0,
                        imagesMbps: p.imagesMbps ?? 0,
                        subtitlesMbps: p.subtitlesMbps ?? 0,
                        trickplayMbps: p.trickplayMbps ?? 0,
                        totalMbps: p.totalMbps ?? 0,
                        hlsSegmentsPeakMbps: p.hlsSegmentsPeakMbps ?? 0,
                        directPlayPeakMbps: p.directPlayPeakMbps ?? 0,
                        liveTVPeakMbps: p.liveTVPeakMbps ?? 0,
                        proxiedStreamsPeakMbps: p.proxiedStreamsPeakMbps ?? 0,
                        imagesPeakMbps: p.imagesPeakMbps ?? 0,
                        subtitlesPeakMbps: p.subtitlesPeakMbps ?? 0,
                        trickplayPeakMbps: p.trickplayPeakMbps ?? 0,
                        totalPeakMbps: p.totalPeakMbps ?? 0,
                    });
                } else {
                    existing.hlsSegmentsMbps += p.hlsSegmentsMbps ?? 0;
                    existing.directPlayMbps += p.directPlayMbps ?? 0;
                    existing.liveTVMbps += p.liveTVMbps ?? 0;
                    existing.proxiedStreamsMbps += p.proxiedStreamsMbps ?? 0;
                    existing.imagesMbps += p.imagesMbps ?? 0;
                    existing.subtitlesMbps += p.subtitlesMbps ?? 0;
                    existing.trickplayMbps += p.trickplayMbps ?? 0;
                    existing.totalMbps += p.totalMbps ?? 0;
                    existing.hlsSegmentsPeakMbps = Math.max(
                        existing.hlsSegmentsPeakMbps,
                        p.hlsSegmentsPeakMbps ?? 0,
                    );
                    existing.directPlayPeakMbps = Math.max(
                        existing.directPlayPeakMbps,
                        p.directPlayPeakMbps ?? 0,
                    );
                    existing.liveTVPeakMbps = Math.max(
                        existing.liveTVPeakMbps,
                        p.liveTVPeakMbps ?? 0,
                    );
                    existing.proxiedStreamsPeakMbps = Math.max(
                        existing.proxiedStreamsPeakMbps,
                        p.proxiedStreamsPeakMbps ?? 0,
                    );
                    existing.imagesPeakMbps = Math.max(
                        existing.imagesPeakMbps,
                        p.imagesPeakMbps ?? 0,
                    );
                    existing.subtitlesPeakMbps = Math.max(
                        existing.subtitlesPeakMbps,
                        p.subtitlesPeakMbps ?? 0,
                    );
                    existing.trickplayPeakMbps = Math.max(
                        existing.trickplayPeakMbps,
                        p.trickplayPeakMbps ?? 0,
                    );
                    existing.totalPeakMbps = Math.max(existing.totalPeakMbps, p.totalPeakMbps ?? 0);
                }
            } catch {
                // skip malformed entries
            }
        }

        return Array.from(grouped.values())
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-60);
    }
}

// Singleton instance
export const bandwidthTracker = new BandwidthTrackerService();

// Auto-reset every 60 seconds to prevent overflow and keep rates current
setInterval(() => {
    bandwidthTracker.reset();
}, 60 * 1000);

setInterval(() => {
    bandwidthTracker.publishSessionBandwidth();
}, SESSION_BANDWIDTH_PUBLISH_MS).unref();
