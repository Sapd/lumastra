// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export const LIVE_TV_QUALITY_CHOICES = [
    'server',
    'adaptive',
    'original',
    '1080p8m',
    '720p4m',
    '540p2m',
    '360p1m',
] as const;

export type LiveTvQualityChoice = (typeof LIVE_TV_QUALITY_CHOICES)[number];

const STORAGE_KEY = 'lumastra:livetv-quality';

export function isLiveTvQualityChoice(value: unknown): value is LiveTvQualityChoice {
    return (
        typeof value === 'string' && LIVE_TV_QUALITY_CHOICES.includes(value as LiveTvQualityChoice)
    );
}

export function getLiveTvQualityPreference(): LiveTvQualityChoice {
    if (typeof localStorage === 'undefined') return 'server';
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        return isLiveTvQualityChoice(value) ? value : 'server';
    } catch {
        return 'server';
    }
}

export function setLiveTvQualityPreference(choice: LiveTvQualityChoice): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, choice);
    } catch {
        // Playback still switches; persistence is best effort in restricted browsers.
    }
}
