// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Static browser capability profiles for the admin compatibility matrix.
 *
 * Each profile exposes two views of the same underlying capabilities:
 *   - `pathScoped`   — PathScopedCapabilities for selectDeliveryPath()
 *   - `deviceCaps`   — DeviceCapabilities for playbackPlanner.createPlan()
 *
 * HEVC note: Firefox added HEVC support in FF 134 (Windows), FF 136 (macOS),
 * FF 137 (Linux). HDR is omitted for Firefox as it is not reliably
 * cross-platform yet.
 */

import type { PathScopedCapabilities } from '$lib/components/player/codec-types.js';
import type { DeviceCapabilities } from '$lib/server/utils/media-compatibility.js';
import { BURN_IN_CODECS } from '$lib/components/player/subtitle-utils.js';

// ──────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────

export interface BrowserProfile {
    /** Machine-readable identifier (e.g. "chrome"). */
    id: string;
    /** Display name shown in UI. */
    name: string;
    /** Per-path codec capabilities (for selectDeliveryPath). */
    pathScoped: PathScopedCapabilities;
    /** Flat device capabilities (for playbackPlanner.createPlan). */
    deviceCaps: DeviceCapabilities;
}

// ──────────────────────────────────────────────────────────
// makeProfile helper
// ──────────────────────────────────────────────────────────

interface PathDef {
    videoCodecs: string[];
    audioCodecs: string[];
    containers?: string[];
}

interface ProfileSpec {
    id: string;
    name: string;
    directFile: PathDef;
    nativeHls: PathDef;
    mseHls: PathDef;
    hdr: { decode: string[]; display: boolean };
    audioSwitching: boolean;
    maxChannels: number;
    codecConstraints: Record<string, { maxLevel?: number }>;
    /** HLS-specific audio codecs (superset of directFile for devices like Safari). */
    hlsAudioCodecs?: string[];
    /** HDR format Set entries for DeviceCapabilities. */
    hdrFormats?: string[];
}

function makeProfile(spec: ProfileSpec): BrowserProfile {
    // Build PathScopedCapabilities
    const pathScoped: PathScopedCapabilities = {
        directFile: {
            videoCodecs: spec.directFile.videoCodecs,
            audioCodecs: spec.directFile.audioCodecs,
            containers: spec.directFile.containers ?? [],
        },
        nativeHls: {
            videoCodecs: spec.nativeHls.videoCodecs,
            audioCodecs: spec.nativeHls.audioCodecs,
        },
        mseHls: {
            videoCodecs: spec.mseHls.videoCodecs,
            audioCodecs: spec.mseHls.audioCodecs,
        },
        subtitleRendering: {
            vtt: true,
            pgs: true,
            ass: true,
            vobsub: true,
            burnInRequired: [...BURN_IN_CODECS],
        },
        hdr: spec.hdr,
        audioSwitching: spec.audioSwitching,
        maxChannels: spec.maxChannels,
        codecConstraints: spec.codecConstraints,
    };

    // Build DeviceCapabilities by unioning all video/audio codecs across paths
    const allVideoCodecs = new Set([
        ...spec.directFile.videoCodecs,
        ...spec.nativeHls.videoCodecs,
        ...spec.mseHls.videoCodecs,
    ]);
    const allAudioCodecs = new Set([
        ...spec.directFile.audioCodecs,
        ...spec.nativeHls.audioCodecs,
        ...spec.mseHls.audioCodecs,
    ]);

    const deviceCaps: DeviceCapabilities = {
        videoCodecs: allVideoCodecs,
        audioCodecs: allAudioCodecs,
        containers: new Set(spec.directFile.containers ?? []),
        canSwitchAudioInDirectPlay: spec.audioSwitching,
        maxAudioChannels: spec.maxChannels,
        codecConstraints: spec.codecConstraints,
        ...(spec.hlsAudioCodecs !== undefined
            ? { hlsAudioCodecs: new Set(spec.hlsAudioCodecs) }
            : {}),
        ...(spec.hdrFormats !== undefined ? { hdrFormats: new Set(spec.hdrFormats) } : {}),
    };

    return { id: spec.id, name: spec.name, pathScoped, deviceCaps };
}

// ──────────────────────────────────────────────────────────
// Shared codec constraint definitions
// ──────────────────────────────────────────────────────────

const STANDARD_CONSTRAINTS: Record<string, { maxLevel?: number }> = {
    h264: { maxLevel: 52 },
    hevc: { maxLevel: 186 },
};

// ──────────────────────────────────────────────────────────
// Browser profiles
// ──────────────────────────────────────────────────────────

const chrome = makeProfile({
    id: 'chrome',
    name: 'Chrome (Desktop)',
    directFile: {
        videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
        audioCodecs: ['aac', 'opus', 'flac'],
        containers: ['mp4', 'webm'],
    },
    nativeHls: {
        videoCodecs: [],
        audioCodecs: [],
    },
    mseHls: {
        videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
        audioCodecs: ['aac', 'opus', 'flac'],
    },
    hdr: { decode: ['hdr10'], display: false },
    audioSwitching: false,
    maxChannels: 2,
    codecConstraints: STANDARD_CONSTRAINTS,
    hdrFormats: ['hdr10'],
});

const safari = makeProfile({
    id: 'safari',
    name: 'Safari (macOS Desktop)',
    directFile: {
        videoCodecs: ['h264', 'hevc', 'av1'],
        audioCodecs: ['aac'],
        containers: ['mp4'],
    },
    nativeHls: {
        videoCodecs: ['h264', 'hevc', 'av1'],
        audioCodecs: ['aac', 'ac3', 'eac3'],
    },
    mseHls: {
        videoCodecs: ['h264', 'hevc', 'av1'],
        audioCodecs: ['aac', 'ac3', 'eac3'],
    },
    hdr: { decode: ['hdr10', 'hlg', 'dolby_vision'], display: true },
    audioSwitching: true,
    maxChannels: 6,
    codecConstraints: STANDARD_CONSTRAINTS,
    hlsAudioCodecs: ['aac', 'ac3', 'eac3'],
    hdrFormats: ['hdr10', 'hlg', 'dovi'],
});

const firefox = makeProfile({
    id: 'firefox',
    name: 'Firefox (Desktop)',
    directFile: {
        videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
        audioCodecs: ['aac', 'opus', 'flac'],
        containers: ['mp4', 'webm'],
    },
    nativeHls: {
        videoCodecs: [],
        audioCodecs: [],
    },
    mseHls: {
        videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
        audioCodecs: ['aac', 'opus', 'flac'],
    },
    hdr: { decode: [], display: false },
    audioSwitching: false,
    maxChannels: 2,
    codecConstraints: STANDARD_CONSTRAINTS,
    // No hdrFormats — not reliably cross-platform
});

const edge = makeProfile({
    id: 'edge',
    name: 'Edge (Desktop)',
    directFile: {
        videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
        audioCodecs: ['aac', 'opus', 'flac'],
        containers: ['mp4', 'webm'],
    },
    nativeHls: {
        videoCodecs: [],
        audioCodecs: [],
    },
    mseHls: {
        videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
        audioCodecs: ['aac', 'opus', 'flac'],
    },
    hdr: { decode: ['hdr10'], display: false },
    audioSwitching: false,
    maxChannels: 2,
    codecConstraints: STANDARD_CONSTRAINTS,
    hdrFormats: ['hdr10'],
});

// ──────────────────────────────────────────────────────────
// Exported profile list
// ──────────────────────────────────────────────────────────

export const BROWSER_PROFILES: BrowserProfile[] = [chrome, safari, firefox, edge];
