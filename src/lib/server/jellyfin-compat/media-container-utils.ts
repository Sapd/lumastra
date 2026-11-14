// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared media container utilities for Jellyfin compat layer.
 * Maps file extensions to container names and detects audio containers.
 */

const CONTAINER_MAP: Record<string, string> = {
    mkv: 'mkv',
    mp4: 'mp4',
    m4v: 'mp4',
    avi: 'avi',
    webm: 'webm',
    mov: 'mov',
    ts: 'ts',
    wmv: 'wmv',
    flac: 'flac',
    mp3: 'mp3',
    m4a: 'm4a',
    m4b: 'm4b',
    aac: 'aac',
    ogg: 'ogg',
    opus: 'opus',
    wav: 'wav',
    wma: 'wma',
};

export function containerFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return (CONTAINER_MAP[ext] ?? ext) || 'mkv';
}

const AUDIO_CONTAINERS = new Set(['flac', 'mp3', 'm4a', 'm4b', 'aac', 'ogg', 'opus', 'wav', 'wma']);

export function isAudioContainer(container: string): boolean {
    return AUDIO_CONTAINERS.has(container);
}

export function deriveQualityLabel(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (lower.includes('4k') || lower.includes('2160')) return '4K';
    if (lower.includes('1080')) return '1080p';
    if (lower.includes('720')) return '720p';
    if (lower.includes('480')) return '480p';
    const ext = filePath.split('.').pop()?.toUpperCase();
    return ext ?? 'Default';
}
