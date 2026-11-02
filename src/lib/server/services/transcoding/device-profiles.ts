// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device Profile Service
 *
 * Manages device profiles for codec/format compatibility.
 * Profiles are bundled at build time from JSON files in ./profiles/
 * which can be exported directly from Jellyfin.
 */

import { Logger } from '../../utils/logger.js';
import { normalizeVideoCodecToken } from '../../utils/media-compatibility.js';
import type { DeviceProfile, JellyfinDeviceProfile, ProfileCondition } from './types.js';

// Import profiles directly - bundled at build time
import appleTvProfile from './profiles/apple-tv.json';
import chromeProfile from './profiles/chrome.json';
import androidTvProfile from './profiles/android-tv.json';
import rokuProfile from './profiles/roku.json';
import tizenProfile from './profiles/tizen.json';
import webosProfile from './profiles/webos.json';

const logger = Logger.for('DeviceProfiles');

/**
 * Default profile used when no matching profile is found.
 * Based on Chrome profile - broadly compatible with modern browsers.
 */
const DEFAULT_PROFILE: DeviceProfile = {
    id: 'default',
    Name: 'Default (Chrome-like)',
    MaxStreamingBitrate: 120000000,
    MaxStaticBitrate: 100000000,
    DirectPlayProfiles: [
        {
            // No HEVC here: this profile serves UNKNOWN devices, and Chrome-class
            // browsers only decode HEVC with hardware support. Transcoding
            // always works; a false direct-play claim does not.
            Container: 'mp4,m4v',
            Type: 'Video',
            VideoCodec: 'h264,vp9,av1',
            AudioCodec: 'aac,mp3,opus,flac',
        },
        {
            Container: 'webm',
            Type: 'Video',
            VideoCodec: 'vp8,vp9,av1',
            AudioCodec: 'vorbis,opus',
        },
    ],
    TranscodingProfiles: [
        {
            Container: 'ts',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac,mp3',
            Protocol: 'hls',
            Context: 'Streaming',
        },
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [
        { Format: 'vtt', Method: 'External' },
        { Format: 'srt', Method: 'External' },
    ],
    // Conservative for unknown devices: tonemapped SDR plays everywhere,
    // HDR passthrough to an SDR-only client produces washed-out video.
    supportsHdr: false,
    supportsDolbyVision: false,
    supportsAtmos: false,
    preferredContainer: 'fmp4',
};

/**
 * Service for loading and managing device profiles.
 */
class DeviceProfileService {
    private profiles: Map<string, DeviceProfile> = new Map();
    private loaded = false;
    private loadPromise: Promise<void> | null = null;

    /**
     * Load profiles from the configured directory.
     */
    async loadProfiles(): Promise<void> {
        if (this.loaded) return;

        if (this.loadPromise) {
            return this.loadPromise;
        }

        this.loadPromise = this._loadProfiles();
        await this.loadPromise;
        this.loaded = true;
        this.loadPromise = null;
    }

    private async _loadProfiles(): Promise<void> {
        // Bundled profiles - imported at build time from ./profiles/*.json
        // Cast through unknown since JSON may have minor type differences (string vs number for some fields)
        const bundledProfiles: Array<{
            id: string;
            data: JellyfinDeviceProfile;
        }> = [
            {
                id: 'apple-tv',
                data: appleTvProfile as unknown as JellyfinDeviceProfile,
            },
            {
                id: 'chrome',
                data: chromeProfile as unknown as JellyfinDeviceProfile,
            },
            {
                id: 'android-tv',
                data: androidTvProfile as unknown as JellyfinDeviceProfile,
            },
            {
                id: 'roku',
                data: rokuProfile as unknown as JellyfinDeviceProfile,
            },
            {
                id: 'tizen',
                data: tizenProfile as unknown as JellyfinDeviceProfile,
            },
            {
                id: 'webos',
                data: webosProfile as unknown as JellyfinDeviceProfile,
            },
        ];

        for (const { id, data } of bundledProfiles) {
            const profile: DeviceProfile = {
                ...data,
                id,
                // Add our custom fields with defaults
                supportsHdr: this.detectHdrSupport(data),
                supportsDolbyVision: this.detectDolbyVisionSupport(data),
                supportsAtmos: this.detectAtmosSupport(data),
                preferredContainer: this.detectPreferredContainer(data),
            };

            this.profiles.set(id, profile);
            logger.debug('Loaded device profile', { id, name: profile.Name });
        }

        // Always have default profile
        this.profiles.set('default', DEFAULT_PROFILE);

        logger.info('Device profiles loaded', {
            count: this.profiles.size,
            profiles: Array.from(this.profiles.keys()),
        });
    }

    /**
     * Get a profile by ID.
     */
    async getProfile(id: string): Promise<DeviceProfile> {
        await this.loadProfiles();
        return this.profiles.get(id) || this.profiles.get('default') || DEFAULT_PROFILE;
    }

    /**
     * Get profile matching User-Agent string.
     */
    async getProfileByUserAgent(userAgent: string): Promise<DeviceProfile> {
        await this.loadProfiles();

        // Check each profile for User-Agent match
        for (const profile of this.profiles.values()) {
            if (profile.userAgentMatch) {
                try {
                    const regex = new RegExp(profile.userAgentMatch, 'i');
                    if (regex.test(userAgent)) {
                        return profile;
                    }
                } catch {
                    // Invalid regex, skip
                }
            }
        }

        // Check for common patterns
        const ua = userAgent.toLowerCase();

        if (ua.includes('appletv') || ua.includes('tvos')) {
            const appleProfile = this.profiles.get('apple-tv') || this.profiles.get('chrome');
            if (appleProfile) return appleProfile;
        }

        if (ua.includes('android') && (ua.includes('tv') || ua.includes('shield'))) {
            const androidProfile = this.profiles.get('android-tv');
            if (androidProfile) return androidProfile;
        }

        if (ua.includes('tizen')) {
            const tizenProfile = this.profiles.get('tizen');
            if (tizenProfile) return tizenProfile;
        }

        // LG TVs identify as "Web0S" (digit zero) in their User-Agent
        if (ua.includes('webos') || ua.includes('web0s')) {
            const webosProfile = this.profiles.get('webos');
            if (webosProfile) return webosProfile;
        }

        if (ua.includes('roku')) {
            const rokuProfile = this.profiles.get('roku');
            if (rokuProfile) return rokuProfile;
        }

        // Default to Chrome profile (most compatible)
        return this.profiles.get('chrome') || this.profiles.get('default') || DEFAULT_PROFILE;
    }

    /**
     * Get all loaded profiles.
     */
    async getAllProfiles(): Promise<DeviceProfile[]> {
        await this.loadProfiles();
        return Array.from(this.profiles.values());
    }

    /**
     * Check if a codec is supported for direct play.
     */
    canDirectPlay(
        profile: DeviceProfile,
        container: string,
        videoCodec?: string,
        audioCodec?: string,
    ): boolean {
        if (!profile.DirectPlayProfiles) return false;
        for (const dp of profile.DirectPlayProfiles) {
            // Check container
            const containers = dp.Container.split(',').map((c) => c.trim().toLowerCase());
            if (!containers.includes(container.toLowerCase())) {
                continue;
            }

            // Check video codec if specified ('h265' alias normalized to 'hevc')
            if (videoCodec && dp.VideoCodec) {
                const videoCodecs = dp.VideoCodec.split(',').map((c) =>
                    normalizeVideoCodecToken(c.trim()),
                );
                if (!videoCodecs.includes(normalizeVideoCodecToken(videoCodec))) {
                    continue;
                }
            }

            // Check audio codec if specified
            if (audioCodec && dp.AudioCodec) {
                const audioCodecs = dp.AudioCodec.split(',').map((c) => c.trim().toLowerCase());
                if (!audioCodecs.includes(audioCodec.toLowerCase())) {
                    continue;
                }
            }

            return true;
        }

        return false;
    }

    /**
     * Check codec profile conditions.
     *
     * `container` (optional) honours Jellyfin's CodecProfile.Container scoping,
     * including the "-mp4,ts" exclusion syntax.
     */
    checkCodecConditions(
        profile: DeviceProfile,
        codec: string,
        properties: Record<string, string | number | boolean>,
        container?: string,
    ): { pass: boolean; failedConditions: string[] } {
        const failedConditions: string[] = [];

        if (!profile.CodecProfiles) {
            return { pass: true, failedConditions: [] };
        }
        for (const cp of profile.CodecProfiles) {
            // Check if this profile applies to our codec.
            // Jellyfin's Codec field may be a comma list (e.g. "ac3,eac3").
            if (
                cp.Codec &&
                !cp.Codec.toLowerCase()
                    .split(',')
                    .map((c) => c.trim())
                    .includes(codec.toLowerCase())
            ) {
                continue;
            }

            // Container scoping ("-mp4,ts" = all containers EXCEPT mp4/ts)
            if (cp.Container && container) {
                const c = container.toLowerCase();
                const negated = cp.Container.startsWith('-');
                const list = (negated ? cp.Container.slice(1) : cp.Container)
                    .toLowerCase()
                    .split(',')
                    .map((s) => s.trim());
                const applies = negated ? !list.includes(c) : list.includes(c);
                if (!applies) continue;
            }

            if (!cp.Conditions) continue;
            // Check each condition
            for (const condition of cp.Conditions) {
                const propValue = properties[condition.Property];
                const conditionValue = condition.Value;

                if (propValue === undefined) continue;

                const pass = this.evaluateCondition(condition, propValue);
                if (!pass) {
                    failedConditions.push(
                        `${condition.Property} ${condition.Condition} ${conditionValue} (got: ${propValue})`,
                    );
                }
            }
        }

        return {
            pass: failedConditions.length === 0,
            failedConditions,
        };
    }

    /**
     * Evaluate a single profile condition.
     */
    private evaluateCondition(
        condition: ProfileCondition,
        value: string | number | boolean,
    ): boolean {
        const conditionValue = condition.Value;

        switch (condition.Condition) {
            case 'Equals':
                return String(value).toLowerCase() === conditionValue.toLowerCase();

            case 'NotEquals':
                return String(value).toLowerCase() !== conditionValue.toLowerCase();

            case 'EqualsAny': {
                const options = conditionValue.split('|').map((o) => o.trim().toLowerCase());
                return options.includes(String(value).toLowerCase());
            }

            case 'LessThanEqual':
                return Number(value) <= Number(conditionValue);

            case 'GreaterThanEqual':
                return Number(value) >= Number(conditionValue);

            default:
                return true;
        }
    }

    /**
     * Detect HDR support from codec profiles.
     */
    private detectHdrSupport(profile: JellyfinDeviceProfile): boolean {
        for (const cp of profile.CodecProfiles) {
            for (const cond of cp.Conditions) {
                if (cond.Property === 'VideoRangeType') {
                    const ranges = cond.Value.split('|').map((r) => r.trim());
                    if (ranges.some((r) => r.includes('HDR') || r.includes('HLG'))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Detect Dolby Vision support from codec profiles.
     */
    private detectDolbyVisionSupport(profile: JellyfinDeviceProfile): boolean {
        for (const cp of profile.CodecProfiles) {
            for (const cond of cp.Conditions) {
                if (cond.Property === 'VideoRangeType') {
                    const ranges = cond.Value.split('|').map((r) => r.trim());
                    // Only the bare 'DOVI' / 'DolbyVision' tokens indicate real DV
                    // decode. Jellyfin's 'DOVIWithHDR10'/'DOVIWithHLG'/'DOVIWithSDR'
                    // tokens mean "plays the *base layer* only" — treating them as
                    // DV support ships un-decodable DV P5 bitstreams to the device.
                    if (ranges.some((r) => r === 'DOVI' || r === 'DolbyVision')) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Detect Atmos support from direct play profiles.
     */
    private detectAtmosSupport(profile: JellyfinDeviceProfile): boolean {
        for (const dp of profile.DirectPlayProfiles) {
            if (dp.AudioCodec) {
                const codecs = dp.AudioCodec.split(',').map((c) => c.trim().toLowerCase());
                if (codecs.includes('truehd') || codecs.includes('eac3')) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Detect preferred container from transcoding profiles.
     */
    private detectPreferredContainer(profile: JellyfinDeviceProfile): 'fmp4' | 'ts' | 'mp4' {
        for (const tp of profile.TranscodingProfiles) {
            if (tp.Type === 'Video' && tp.Protocol === 'hls') {
                const container = tp.Container.toLowerCase();
                if (container === 'mp4' || container.includes('fmp4')) {
                    return 'fmp4';
                }
                if (container === 'ts') {
                    return 'ts';
                }
            }
        }
        return 'ts'; // Default to TS for broadest compatibility
    }

    /**
     * Force reload of profiles.
     */
    async reloadProfiles(): Promise<void> {
        this.profiles.clear();
        this.loaded = false;
        await this.loadProfiles();
    }
}

// Export singleton instance
export const deviceProfiles = new DeviceProfileService();

// Export class for testing
export { DeviceProfileService };

// Export default profile for reference
export { DEFAULT_PROFILE };
