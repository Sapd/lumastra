// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { BROWSER_PROFILES, type BrowserProfile } from './browser-profiles.js';

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function getProfile(id: string): BrowserProfile {
    const p = BROWSER_PROFILES.find((b) => b.id === id);
    if (!p) throw new Error(`Profile not found: ${id}`);
    return p;
}

// ──────────────────────────────────────────────────────────
// Profile count
// ──────────────────────────────────────────────────────────

describe('BROWSER_PROFILES', () => {
    it('exports exactly 4 profiles', () => {
        expect(BROWSER_PROFILES).toHaveLength(4);
    });

    it('has unique ids', () => {
        const ids = BROWSER_PROFILES.map((p) => p.id);
        expect(new Set(ids).size).toBe(4);
    });
});

// ──────────────────────────────────────────────────────────
// Shape validation — every profile must satisfy these
// ──────────────────────────────────────────────────────────

describe.each(BROWSER_PROFILES.map((p) => [p.id, p] as [string, BrowserProfile]))(
    'profile "%s" shape',
    (_id, profile) => {
        it('pathScoped has arrays for directFile, nativeHls, mseHls', () => {
            expect(Array.isArray(profile.pathScoped.directFile.videoCodecs)).toBe(true);
            expect(Array.isArray(profile.pathScoped.directFile.audioCodecs)).toBe(true);
            expect(Array.isArray(profile.pathScoped.directFile.containers)).toBe(true);
            expect(Array.isArray(profile.pathScoped.nativeHls.videoCodecs)).toBe(true);
            expect(Array.isArray(profile.pathScoped.nativeHls.audioCodecs)).toBe(true);
            expect(Array.isArray(profile.pathScoped.mseHls.videoCodecs)).toBe(true);
            expect(Array.isArray(profile.pathScoped.mseHls.audioCodecs)).toBe(true);
        });

        it('pathScoped has subtitle rendering fields', () => {
            const sub = profile.pathScoped.subtitleRendering;
            expect(typeof sub.vtt).toBe('boolean');
            expect(typeof sub.pgs).toBe('boolean');
            expect(typeof sub.ass).toBe('boolean');
            expect(typeof sub.vobsub).toBe('boolean');
            expect(Array.isArray(sub.burnInRequired)).toBe(true);
        });

        it('pathScoped burnInRequired contains dvbsub and xsub', () => {
            expect(profile.pathScoped.subtitleRendering.burnInRequired).toContain('dvbsub');
            expect(profile.pathScoped.subtitleRendering.burnInRequired).toContain('xsub');
        });

        it('deviceCaps has Sets for videoCodecs and audioCodecs', () => {
            expect(profile.deviceCaps.videoCodecs).toBeInstanceOf(Set);
            expect(profile.deviceCaps.audioCodecs).toBeInstanceOf(Set);
        });

        it('deviceCaps has maxAudioChannels and codecConstraints', () => {
            expect(typeof profile.deviceCaps.maxAudioChannels).toBe('number');
            expect(typeof profile.deviceCaps.codecConstraints).toBe('object');
        });

        it('deviceCaps codecConstraints has h264 and hevc entries', () => {
            const cc = profile.deviceCaps.codecConstraints;
            expect(cc?.['h264']).toBeDefined();
            expect(cc?.['hevc']).toBeDefined();
            expect(cc?.['h264']?.maxLevel).toBe(52);
            expect(cc?.['hevc']?.maxLevel).toBe(186);
        });
    },
);

// ──────────────────────────────────────────────────────────
// Safari-specific
// ──────────────────────────────────────────────────────────

describe('Safari profile', () => {
    const safari = getProfile('safari');

    it('has native HLS video codecs (hevc, h264, av1)', () => {
        expect(safari.pathScoped.nativeHls.videoCodecs).toContain('hevc');
        expect(safari.pathScoped.nativeHls.videoCodecs).toContain('h264');
        expect(safari.pathScoped.nativeHls.videoCodecs).toContain('av1');
    });

    it('has native HLS audio codecs (aac, ac3, eac3)', () => {
        expect(safari.pathScoped.nativeHls.audioCodecs).toContain('aac');
        expect(safari.pathScoped.nativeHls.audioCodecs).toContain('ac3');
        expect(safari.pathScoped.nativeHls.audioCodecs).toContain('eac3');
    });

    it('supports audio switching', () => {
        expect(safari.pathScoped.audioSwitching).toBe(true);
        expect(safari.deviceCaps.canSwitchAudioInDirectPlay).toBe(true);
    });

    it('has hlsAudioCodecs Set with ac3 and eac3', () => {
        expect(safari.deviceCaps.hlsAudioCodecs).toBeInstanceOf(Set);
        expect(safari.deviceCaps.hlsAudioCodecs?.has('ac3')).toBe(true);
        expect(safari.deviceCaps.hlsAudioCodecs?.has('eac3')).toBe(true);
    });

    it('supports HDR formats including dovi and hlg', () => {
        expect(safari.deviceCaps.hdrFormats?.has('dovi')).toBe(true);
        expect(safari.deviceCaps.hdrFormats?.has('hdr10')).toBe(true);
        expect(safari.deviceCaps.hdrFormats?.has('hlg')).toBe(true);
    });

    it('has maxChannels of 6', () => {
        expect(safari.pathScoped.maxChannels).toBe(6);
        expect(safari.deviceCaps.maxAudioChannels).toBe(6);
    });

    it('only plays mp4 containers in direct file (no mkv, no webm)', () => {
        expect(safari.pathScoped.directFile.containers).toContain('mp4');
        expect(safari.pathScoped.directFile.containers).not.toContain('webm');
        expect(safari.pathScoped.directFile.containers).not.toContain('mkv');
    });
});

// ──────────────────────────────────────────────────────────
// Firefox HEVC support (updated: FF 134+)
// ──────────────────────────────────────────────────────────

describe('Firefox profile', () => {
    const firefox = getProfile('firefox');

    it('includes hevc in direct file video codecs', () => {
        expect(firefox.pathScoped.directFile.videoCodecs).toContain('hevc');
    });

    it('includes hevc in MSE HLS video codecs', () => {
        expect(firefox.pathScoped.mseHls.videoCodecs).toContain('hevc');
    });

    it('includes hevc in deviceCaps videoCodecs Set', () => {
        expect(firefox.deviceCaps.videoCodecs.has('hevc')).toBe(true);
    });

    it('has empty HDR decode array (not reliably cross-platform)', () => {
        expect(firefox.pathScoped.hdr.decode).toHaveLength(0);
    });

    it('has no native HLS video codecs', () => {
        expect(firefox.pathScoped.nativeHls.videoCodecs).toHaveLength(0);
    });
});

// ──────────────────────────────────────────────────────────
// Chrome and Edge HEVC support
// ──────────────────────────────────────────────────────────

describe('Chrome profile', () => {
    const chrome = getProfile('chrome');

    it('includes hevc in direct file and MSE HLS video codecs', () => {
        expect(chrome.pathScoped.directFile.videoCodecs).toContain('hevc');
        expect(chrome.pathScoped.mseHls.videoCodecs).toContain('hevc');
    });

    it('includes hevc in deviceCaps videoCodecs Set', () => {
        expect(chrome.deviceCaps.videoCodecs.has('hevc')).toBe(true);
    });

    it('has no native HLS video codecs', () => {
        expect(chrome.pathScoped.nativeHls.videoCodecs).toHaveLength(0);
    });
});

describe('Edge profile', () => {
    const edge = getProfile('edge');

    it('includes hevc in direct file and MSE HLS video codecs', () => {
        expect(edge.pathScoped.directFile.videoCodecs).toContain('hevc');
        expect(edge.pathScoped.mseHls.videoCodecs).toContain('hevc');
    });

    it('includes hevc in deviceCaps videoCodecs Set', () => {
        expect(edge.deviceCaps.videoCodecs.has('hevc')).toBe(true);
    });

    it('has no native HLS video codecs', () => {
        expect(edge.pathScoped.nativeHls.videoCodecs).toHaveLength(0);
    });
});

// ──────────────────────────────────────────────────────────
// Only Safari has native HLS video codecs
// ──────────────────────────────────────────────────────────

describe('native HLS exclusivity', () => {
    it('only Safari has non-empty nativeHls.videoCodecs', () => {
        for (const profile of BROWSER_PROFILES) {
            if (profile.id === 'safari') {
                expect(profile.pathScoped.nativeHls.videoCodecs.length).toBeGreaterThan(0);
            } else {
                expect(profile.pathScoped.nativeHls.videoCodecs).toHaveLength(0);
            }
        }
    });

    it('only Safari has non-empty nativeHls.audioCodecs', () => {
        for (const profile of BROWSER_PROFILES) {
            if (profile.id === 'safari') {
                expect(profile.pathScoped.nativeHls.audioCodecs.length).toBeGreaterThan(0);
            } else {
                expect(profile.pathScoped.nativeHls.audioCodecs).toHaveLength(0);
            }
        }
    });
});

// ──────────────────────────────────────────────────────────
// Non-Safari profiles have no audio switching
// ──────────────────────────────────────────────────────────

describe('audio switching', () => {
    it('only Safari has audioSwitching enabled', () => {
        for (const profile of BROWSER_PROFILES) {
            if (profile.id === 'safari') {
                expect(profile.pathScoped.audioSwitching).toBe(true);
            } else {
                expect(profile.pathScoped.audioSwitching).toBe(false);
            }
        }
    });
});
