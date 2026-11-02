// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { source, webFeatures } = vi.hoisted(() => ({
    source: {} as Record<string, boolean | string | string[]>,
    webFeatures: {} as Record<string, boolean>,
}));
const { scanStatus, scanWarn } = vi.hoisted(() => ({ scanStatus: vi.fn(), scanWarn: vi.fn() }));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => ({ warn: scanWarn }) } }));
vi.mock('$lib/server/config/server-id.js', () => ({
    getServerId: async () => '11111111-1111-4111-8111-111111111111',
}));
vi.mock('$lib/server/config.js', () => ({
    config: new Proxy(
        {},
        {
            get: (_target, key) =>
                key === 'buildInfo' ? { version: '1.0.0' } : (source[String(key)] ?? false),
        },
    ),
    features: new Proxy({}, { get: (_target, key) => source[String(key)] ?? false }),
}));
vi.mock('$lib/server/server-branding.js', () => ({
    getServerFeatures: async () => webFeatures,
    getServerBranding: async () => ({ appName: 'Lumastra', appDescription: 'Media' }),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/database/queries/library-types.queries.js', () => ({
    getActiveLibraryTypes: vi.fn(),
}));
vi.mock('$lib/server/jellyseerr.js', () => ({ jellyseerrClient: { isConfigured: () => true } }));
vi.mock('$lib/server/licensing/entitlements.js', () => ({
    getEffectiveEntitlements: async () => ({ modules: new Set<string>() }),
}));
vi.mock('$lib/server/services/push/push-transport-selector.js', () => ({
    hasUsablePushCredential: () => false,
}));
vi.mock('$lib/server/services/initial-scan-status.service.js', () => ({
    getInitialScanStatus: scanStatus,
}));
import type { RequestEvent } from '@sveltejs/kit';
import { DependencyUnavailableError } from '$lib/server/api/problem.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import { ServerInfoSchema, ServerFeaturesSchema } from '$lib/schemas/server-info.js';
import { buildServerCapabilities } from './capabilities.js';

function atPath(value: unknown, path: string): unknown {
    for (const key of path.split('.')) value = (value as Record<string, unknown>)[key];
    return value;
}
const flags = [
    ['features.ai_recommendations', 'aiRecommendations', 'features.aiRecommendations'],
    ['features.ai_assistant', 'aiAssistant', 'features.aiAssistant'],
    ['features.livetv', 'liveTV', 'liveTv.available'],
    ['features.watch_together', 'watchTogether', 'features.watchTogether'],
    ['features.social', 'social', 'features.social'],
    ['features.music_clustering', 'musicClustering', 'music.clustering'],
    ['features.video_previews', 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', 'features.videoPreviews'],
    ['features.top_shelf_previews', 'FEATURE_TOPSHELF_PREVIEWS', 'features.topShelfPreviews'],
    ['features.top_shelf_overlay', 'FEATURE_TOPSHELF_PREVIEWS', 'features.topShelfOverlay'],
    ['features.media_download', 'FEATURE_MEDIA_DOWNLOAD', 'features.mediaDownload'],
    ['features.download_renditions', 'FEATURE_DOWNLOAD_RENDITIONS', 'features.downloadRenditions'],
    [
        'features.series_smart_downloads',
        'FEATURE_DOWNLOAD_RENDITIONS',
        'features.seriesSmartDownloads',
    ],
    ['playback.remux', 'ffmpegAvailable', 'playback.remux'],
    ['playback.transcode', 'ffmpegAvailable', 'playback.transcode'],
    [
        'live_tv.adaptive_ladder_enabled',
        'LIVETV_ADAPTIVE_LADDER_ENABLED',
        'liveTv.adaptiveLadder.enabled',
    ],
] as const;

describe('old capability values retain their canonical home', () => {
    it('advertises first-scan state to signed-in clients', async () => {
        expect((await buildServerCapabilities('v1', true)).library).toEqual({
            initialScanRunning: true,
            itemsSoFar: 23,
        });
    });
    it('omits global counts for non-admins, including the default caller', async () => {
        expect((await buildServerCapabilities('v1', false)).library).toEqual({
            initialScanRunning: true,
        });
        expect((await buildServerCapabilities('v1')).library).toEqual({ initialScanRunning: true });
        expect((await buildServerCapabilities('v1', true)).library).toEqual({
            initialScanRunning: true,
            itemsSoFar: 23,
        });
    });
    it.each([false, true])(
        'projects scan counts using credential admin authority %s',
        async (admin) => {
            const { def } = await import('./index.js');
            const principal = buildPrincipal({
                kind: 'pat',
                userId: toUserId('22222222-2222-4222-8222-222222222222'),
                username: 'restricted',
                userGroups: ['age-6'],
                ownerIsAdmin: true,
                tokenScopes: admin ? ['admin'] : ['read'],
            });
            const response = await def.handlers.GET!(
                {
                    request: new Request('https://example.com/api/v1/server'),
                    locals: {
                        principal,
                        user: { ownerIsAdmin: true, maxAgeRating: 6, isAgeRestricted: true },
                    },
                } as unknown as RequestEvent,
                { surface: 'v1' },
            );
            expect(response.status).toBe(200);
            const body = ServerInfoSchema.parse(await response.json());
            expect(body).toHaveProperty(
                'capabilities.library',
                admin ? { initialScanRunning: true, itemsSoFar: 23 } : { initialScanRunning: true },
            );
        },
    );
    it.each([
        new Error('Valkey unavailable'),
        new DependencyUnavailableError('Database unavailable'),
    ])('keeps signed-in discovery available when scan status fails: %s', async (error) => {
        scanStatus.mockRejectedValue(error);
        source.ffmpegAvailable = true;
        const { def } = await import('./index.js');
        const principal = buildPrincipal({
            kind: 'session',
            userId: toUserId('22222222-2222-4222-8222-222222222222'),
            username: 'test',
            userGroups: [],
            sessionIsAdmin: true,
        });
        const response = await def.handlers.GET!(
            {
                request: new Request('https://example.com/api/v1/server'),
                locals: { principal },
            } as unknown as RequestEvent,
            { surface: 'v1' },
        );
        expect(response.status).toBe(200);
        const body = ServerInfoSchema.parse(await response.json());
        expect(body).toHaveProperty('capabilities.library', {
            initialScanRunning: false,
            itemsSoFar: 0,
        });
        expect(body).toHaveProperty('capabilities.playback.transcode', true);
        expect(body).toHaveProperty('capabilities.playback.transcoder.engine', 'ffmpeg');
        expect(body).toHaveProperty('capabilities.push.available', false);
        expect(body).toHaveProperty('capabilities.events.href', '/api/v1/events');
        expect(scanWarn).toHaveBeenCalled();
    });
    beforeEach(() => {
        scanStatus.mockReset().mockResolvedValue({ initialScanRunning: true, itemsSoFar: 23 });
        scanWarn.mockClear();
        for (const key of Object.keys(source)) delete source[key];
        for (const key of Object.keys(webFeatures)) delete webFeatures[key];
        source.METADATA_ADDITIONAL_LANGUAGES = [];
        source.LIVETV_DEFAULT_QUALITY = 'adaptive';
    });
    it.each(flags)('%s => %s => %s', async (_oldKey, sourceKey, target) => {
        source[sourceKey] = false;
        webFeatures[sourceKey] = false;
        expect(atPath(await buildServerCapabilities('v1'), target)).toBe(false);
        source[sourceKey] = true;
        webFeatures[sourceKey] = true;
        expect(atPath(await buildServerCapabilities('v1'), target)).toBe(true);
    });
    it.each([
        ['playback.direct', 'playback.direct', true],
        ['transcoder.engine', 'playback.transcoder.engine', 'ffmpeg'],
        [
            'transcoder.output_video_codecs',
            'playback.transcoder.videoCodecs',
            ['h264', 'hevc', 'av1'],
        ],
        [
            'transcoder.output_audio_codecs',
            'playback.transcoder.audioCodecs',
            ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'opus'],
        ],
        ['transcoder.output_containers', 'playback.transcoder.containers', ['mp4', 'mkv', 'ts']],
        ['transcoder.max_resolution', 'playback.transcoder.maxResolution', '4K'],
        ['transcoder.hdr_passthrough', 'playback.transcoder.hdrPassthrough', true],
        [
            'transcoder.dolby_vision_passthrough',
            'playback.transcoder.dolbyVisionPassthrough',
            false,
        ],
        ['streaming.max_bitrate_kbps', 'playback.maxBitrateKbps', null],
        ['events.reconnect_max_ms', 'events.reconnectMaxMs', 30000],
        ['features.music', 'music.available', false],
    ])('%s => %s preserves %j', async (_oldKey, target, expected) => {
        expect(atPath(await buildServerCapabilities('v1'), target as string)).toEqual(expected);
    });
    const retainedFeatureKeys = Object.keys(ServerFeaturesSchema.shape).filter(
        (key) => !flags.some(([, , target]) => target === `features.${key}`),
    );
    it.each(retainedFeatureKeys)('config.features.%s keeps its boolean value', async (key) => {
        webFeatures[key] = false;
        expect(atPath(await buildServerCapabilities('v1'), `features.${key}`)).toBe(false);
        webFeatures[key] = true;
        expect(atPath(await buildServerCapabilities('v1'), `features.${key}`)).toBe(true);
    });
    it('maps the HLS ladder and language settings from their original sources', async () => {
        source.ffmpegAvailable = true;
        source.TMDB_LANGUAGE = 'de-DE';
        source.METADATA_ADDITIONAL_LANGUAGES = ['fr'];
        const capabilities = await buildServerCapabilities('v1');
        expect(capabilities.playback.hlsVariants).toEqual(['360p', '480p', '720p', '1080p', '4K']);
        expect(capabilities.metadata).toEqual({ primary: 'de', additional: ['fr'] });
        expect(capabilities.events.href).toBe('/api/v1/events');
        expect(capabilities.liveTv.adaptiveLadder.rungs[0]).toEqual({
            id: '1080p8m',
            height: 1080,
            maxBitrateBps: 8_000_000,
            codec: 'h264',
        });
    });
});
