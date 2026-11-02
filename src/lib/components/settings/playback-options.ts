// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PlaybackPreferences } from '$lib/components/player/preferences-sync.svelte';

export interface QualityModeOption {
    value: PlaybackPreferences['qualityMode'];
    label: string;
    hint: string;
}

export const QUALITY_MODE_OPTIONS: QualityModeOption[] = [
    { value: 'original', label: 'Original', hint: 'Direct play when possible.' },
    { value: 'auto', label: 'Auto', hint: 'Adapt to your connection.' },
    { value: 'fixed', label: 'Fixed bitrate', hint: 'Cap at a chosen bitrate.' },
];

export interface ResolutionOption {
    value: string | null;
    label: string;
}

export const RESOLUTION_OPTIONS: ResolutionOption[] = [
    { value: null, label: 'Auto' },
    { value: '2160p', label: '4K (2160p)' },
    { value: '1080p', label: '1080p' },
    { value: '720p', label: '720p' },
    { value: '480p', label: '480p' },
];

/** Common max-bitrate caps (bits/sec) offered for the fixed mode. */
export const MAX_BITRATE_OPTIONS: { value: number; label: string }[] = [
    { value: 20_000_000, label: '20 Mbps' },
    { value: 12_000_000, label: '12 Mbps' },
    { value: 8_000_000, label: '8 Mbps' },
    { value: 4_000_000, label: '4 Mbps' },
    { value: 2_000_000, label: '2 Mbps' },
];

export function bitrateLabel(bps: number): string {
    return `${bps / 1_000_000} Mbps`;
}

export function isFixedMode(mode: PlaybackPreferences['qualityMode']): boolean {
    return mode === 'fixed';
}
