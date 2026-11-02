// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

export interface PreviewProfile {
    videoCodec: string;
    audioCodec: 'aac';
    /** Resolved absolute stream index; null when the source has no selected audio. */
    audioTrackIndex: number | null;
    maxWidth: number;
    maxHeight: number;
    maxDurationSeconds: number;
    encodingPreset: string;
}

/** Canonicalize a raw seek to its bucket centre (never negative). */
export function seekBucket(rawSeekSeconds: number, bucketSeconds: number): number {
    if (bucketSeconds <= 0) return Math.max(0, Math.round(rawSeekSeconds));
    const b = Math.round(rawSeekSeconds / bucketSeconds) * bucketSeconds;
    return Math.max(0, b);
}

/** 12-hex-char hash of the resolved encode parameters. */
export function profileId(p: PreviewProfile): string {
    const canonical = `${p.videoCodec}|${p.audioCodec}|a${p.audioTrackIndex ?? 'none'}|${p.maxWidth}x${p.maxHeight}|t${p.maxDurationSeconds}|${p.encodingPreset}`;
    return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function buildPreviewKey(input: {
    fileId: string;
    rawSeekSeconds: number;
    bucketSeconds: number;
    profile: PreviewProfile;
    fileVersion: string;
}): string {
    const bucket = seekBucket(input.rawSeekSeconds, input.bucketSeconds);
    const parts = [input.fileId, String(bucket), profileId(input.profile), input.fileVersion];
    return createHash('sha256').update(parts.join(':')).digest('hex');
}
