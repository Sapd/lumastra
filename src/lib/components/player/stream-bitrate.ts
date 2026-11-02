// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The bitrate of the stream actually being played, measured from the segments
 * that arrive: bytes x 8 / seconds of MEDIA they carry.
 *
 * Not the download speed. hls.js's `bandwidthEstimate` (what the player's stats
 * pill used to show) is bytes over TRANSFER time, i.e. how fast the link
 * delivered a burst. On a LAN a 4 Mbps 720p stream showed "330 Mbps" and
 * "47.3 Mbps" (Windows e2e 2026-09-27, polish), which reads as the stream's
 * quality and is nothing of the sort. Averaged over a sliding window of
 * segments so a single short or oversized segment does not make it jump.
 */

/** Segments averaged. ~6 segments of 4-6 s is roughly half a minute of media. */
const WINDOW = 6;

export interface StreamBitrateSample {
    /** Bytes of the segment. */
    bytes: number;
    /** Seconds of media in the segment (its EXTINF duration). */
    mediaSec: number;
}

export class StreamBitrateMeter {
    private samples: StreamBitrateSample[] = [];

    /** Record a delivered segment; returns the current estimate (bits/s) or null. */
    add(sample: StreamBitrateSample): number | null {
        if (
            !Number.isFinite(sample.bytes) ||
            !Number.isFinite(sample.mediaSec) ||
            sample.bytes <= 0 ||
            sample.mediaSec <= 0
        ) {
            return this.current();
        }
        this.samples.push(sample);
        if (this.samples.length > WINDOW) this.samples.shift();
        return this.current();
    }

    current(): number | null {
        if (this.samples.length === 0) return null;
        let bytes = 0;
        let seconds = 0;
        for (const s of this.samples) {
            bytes += s.bytes;
            seconds += s.mediaSec;
        }
        return seconds > 0 ? Math.round((bytes * 8) / seconds) : null;
    }

    /** New stream (quality switch, restart, new item): forget the old one. */
    reset(): void {
        this.samples = [];
    }
}

/** "4.1 Mbps" / "850 kbps" — compact, for the stats pill. */
export function formatStreamBitrate(bitsPerSecond: number): string {
    if (bitsPerSecond >= 1_000_000) {
        const mbps = bitsPerSecond / 1_000_000;
        return `${mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
    }
    return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/**
 * The resolution actually being decoded ("1280x720"), from the media element.
 * The transcoding info carries the SOURCE file's resolution, so a 720p
 * transcode of a 1080p file used to show 1920x1080. Null until the element
 * knows its dimensions (and for audio-only).
 */
export function decodedResolution(
    video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'> | null | undefined,
): string | null {
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    return `${video.videoWidth}x${video.videoHeight}`;
}
