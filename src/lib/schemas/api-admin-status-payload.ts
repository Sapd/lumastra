// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE canonical admin status payload (admin IA redesign, spec §5).
 *
 * One GET (/api/admin/status) serves everything the admin chrome needs:
 * verdict + attention items (the bell, Home's Needs-Attention list and the
 * Health findings are the SAME array), the legacy system block (nested
 * unchanged), the former /status/extras block (served inline), session/task/
 * library/user counters for Home's stat strip, and per-nav-section status
 * dots derived server-side so no client ever recomputes a verdict.
 */

import { z } from 'zod';
import {
    AttentionItemSchema,
    AttentionVerdictSchema,
    AttentionActivitySchema,
    RecentlyAddedItemSchema,
} from './api-attention-responses.js';
import {
    AdminStatusResponseSchema,
    AdminStatusExtrasResponseSchema,
} from './api-admin-responses.js';

/** Compact "now playing" row for Home's mini-strip (NOT the full session shape). */
export const NowPlayingRowSchema = z
    .object({
        sessionId: z.string().describe('play_sessions.id'),
        username: z.string().describe('Display login handle, never a UUID'),
        title: z.string().describe('Live media title (episode or movie title)'),
        progressPercent: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe('Playback progress 0–100; omitted when runtime is unknown'),
        playMethod: z
            .enum(['direct', 'transcode'])
            .optional()
            .describe('Coarse delivery chip — direct play vs any transcode'),
        source: z
            .enum([
                'lumastra',
                'jellyfin',
                'livetv',
                'music',
                'subsonic',
                'audiobookshelf',
                'local',
            ])
            .optional()
            .describe('Originating session source, for the source badge'),
        isCompat: z
            .boolean()
            .optional()
            .describe(
                'True when a Lumastra session came in through the /j Jellyfin-compat surface',
            ),
        formFactor: z
            .enum(['desktop', 'mobile', 'tablet', 'tv', 'unknown'])
            .optional()
            .describe('Coarse client device class, for the device icon'),
        bitrateKbps: z
            .number()
            .optional()
            .describe('Source bitrate in kbps, for the quality badge'),
        resolution: z.string().optional().describe('Source resolution (e.g. "1920x1080")'),
        seriesName: z
            .string()
            .optional()
            .describe('Series name, resolved from the grandparent media_items row (episodes only)'),
        seasonNumber: z
            .number()
            .int()
            .optional()
            .describe('Season number of the live episode (undefined for non-episode media)'),
        episodeNumber: z
            .number()
            .int()
            .optional()
            .describe('Episode number of the live episode (undefined for non-episode media)'),
        isPaused: z.boolean().optional().describe('The session is paused (not actively playing)'),
        posterMediaId: z
            .string()
            .optional()
            .describe(
                'media_items id whose poster represents this session (the series for episodes)',
            ),
        struggling: z
            .boolean()
            .optional()
            .describe(
                'Needs a look: stalled, errored, low buffer, or a playing transcode about to run out of output. Same rule as the Active sessions table',
            ),
        transcoding: z.boolean().optional().describe('Video or audio is being transcoded'),
        bandwidthMbps: z.number().optional().describe('Current delivery bandwidth, Mbps'),
        encodeSpeed: z
            .number()
            .optional()
            .describe(
                'Transcode speed as a multiple of realtime (1 = realtime); derived from segment counts',
            ),
    })
    .meta({ id: 'NowPlayingRow', description: 'Compact now-playing row for the admin Home strip' });
export type NowPlayingRow = z.infer<typeof NowPlayingRowSchema>;

const ClusterGlanceLevelSchema = z
    .enum(['ok', 'warn', 'critical'])
    .describe('ok, warn (amber) or critical (red)')
    .meta({ id: 'ClusterGlanceLevel' });
export type ClusterGlanceLevel = z.infer<typeof ClusterGlanceLevelSchema>;

/** Home's one-glance cluster tile (utils/admin/cluster-glance.ts builds it). */
export const ClusterGlanceSchema = z
    .object({
        level: ClusterGlanceLevelSchema.describe('Worst level of every figure below'),
        services: z.object({
            up: z.number().int().min(0).describe('Services answering on time'),
            expected: z
                .number()
                .int()
                .min(0)
                .describe('Configured services, including ones that stopped answering'),
            late: z.number().int().min(0).describe('Services whose heartbeat is late'),
        }),
        hostCount: z.number().int().min(0).describe('Machines the services run on'),
        uncleanExits24h: z
            .number()
            .int()
            .min(0)
            .describe('Unclean exits (crash, OOM kill) of live services in the last 24 hours'),
        hostMemory: z
            .object({
                usedRatio: z.number().describe('1 - MemAvailable / MemTotal'),
                availableBytes: z.number(),
                totalBytes: z.number(),
                host: z.string().optional().describe('Machine label; only with several machines'),
                level: ClusterGlanceLevelSchema,
            })
            .optional()
            .describe('The machine with the least memory available'),
        container: z
            .object({
                role: z.enum(['web', 'worker', 'proxy', 'general']),
                usedBytes: z.number(),
                limitBytes: z.number(),
                host: z.string().optional(),
                ratio: z.number().describe('usedBytes / limitBytes'),
                peakBytes: z
                    .number()
                    .optional()
                    .describe(
                        'Highest working set in the last 24 hours, when the service reports it',
                    ),
                peakRatio: z.number().optional().describe('peakBytes / limitBytes'),
                level: ClusterGlanceLevelSchema,
            })
            .optional()
            .describe(
                'The service closest to its memory limit, now or at its 24 h peak; absent when none has a limit',
            ),
        cpu: z
            .object({
                load: z.number().describe('Load average (5 min, else 1 min)'),
                cores: z.number(),
                ratio: z.number().describe('load / cores'),
                host: z.string().optional(),
                level: ClusterGlanceLevelSchema,
            })
            .optional()
            .describe('The machine with the highest load per CPU'),
        disk: z
            .object({
                role: z.enum(['cache', 'transcode', 'data']),
                freeBytes: z.number(),
                totalBytes: z.number(),
                freeRatio: z.number(),
                host: z.string().optional(),
                level: ClusterGlanceLevelSchema,
            })
            .optional()
            .describe('The volume with the least free space'),
        gpu: z
            .object({
                inUse: z
                    .number()
                    .int()
                    .min(0)
                    .describe('Open NVENC sessions, else FFmpeg processes on the GPU'),
                max: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe('NVENC session cap; absent for Intel/AMD (no fixed cap)'),
                videoPercent: z
                    .number()
                    .optional()
                    .describe('Video engine (encode/decode) use, percent, when measured'),
                videoScope: z
                    .enum(['lumastra', 'host'])
                    .optional()
                    .describe(
                        'Whether videoPercent measures Lumastra FFmpeg engines or a host device encoder',
                    ),
                utilizationPercent: z
                    .number()
                    .optional()
                    .describe('Highest measured host-wide device utilization, never awake time'),
                host: z.string().optional(),
                level: ClusterGlanceLevelSchema,
            })
            .optional()
            .describe('GPU encode load of the busiest GPU host; absent without a GPU'),
    })
    .meta({ id: 'ClusterGlance', description: "Home's one-glance summary of the cluster view" });
export type ClusterGlance = z.infer<typeof ClusterGlanceSchema>;

/** The seven admin nav sections (spec §3). */
export const AdminSectionIdSchema = z
    .enum(['home', 'library', 'tasks', 'system', 'users', 'settings', 'developer'])
    .describe('Admin navigation section id')
    .meta({ id: 'AdminSectionId' });
export type AdminSectionId = z.infer<typeof AdminSectionIdSchema>;

export const AdminStatusPayloadSchema = z
    .object({
        generatedAt: z.string().describe('ISO 8601 — when this payload was computed'),
        /** THE verdict; nothing else derives one (bell = Home = Health). */
        verdict: AttentionVerdictSchema,
        attention: z
            .object({
                items: z.array(AttentionItemSchema).describe('Open attention items'),
                unreadCount: z.number().int().min(0).describe('Unacknowledged items'),
                activity: AttentionActivitySchema.optional(),
                recentlyAdded: z.array(RecentlyAddedItemSchema).optional(),
                resolvedHistory: z
                    .array(AttentionItemSchema)
                    .optional()
                    .describe('Recently auto-resolved items'),
                unavailable: z
                    .boolean()
                    .optional()
                    .describe(
                        'True when the attention block could not be computed — verdict is a conservative fallback and items/activity/recentlyAdded are not authoritative (empty, not "all clear")',
                    ),
            })
            .describe('The one attention array every admin surface renders'),
        /** Existing system-status shape, unchanged, nested. */
        system: AdminStatusResponseSchema,
        /** Former /api/admin/status/extras block (versions etc.), served inline. */
        extras: AdminStatusExtrasResponseSchema.optional(),
        sessions: z.object({
            count: z.number().int().min(0).describe('Active play sessions'),
            preview: z
                .array(NowPlayingRowSchema)
                .describe('All active now-playing rows (one per session)'),
            load: z
                .object({
                    transcoding: z.number().int().min(0),
                    struggling: z.number().int().min(0),
                    bandwidthMbps: z
                        .number()
                        .min(0)
                        .describe('Sum of per-session delivery bandwidth'),
                })
                .optional()
                .describe(
                    'Totals across active sessions; omitted when the glance could not be computed',
                ),
            lastEnded: z
                .object({
                    username: z.string(),
                    title: z.string().optional(),
                    endedAt: z.string().describe('ISO 8601'),
                })
                .optional()
                .describe('Most recently ended session; only computed while nobody is watching'),
        }),
        tasks: z.object({
            running: z.number().int().min(0).describe('Runs currently executing'),
            ranToday: z.number().int().min(0).describe('Completed runs since midnight UTC'),
            failedRuns24h: z
                .number()
                .int()
                .min(0)
                .describe('Actionable failed runs, last 24 h (same predicate as spike alerts)'),
        }),
        library: z.object({
            totalItems: z.number().int().min(0).describe('Total active media items'),
            totalSizeBytes: z.number().optional().describe('Sum of media file sizes in bytes'),
        }),
        users: z.object({
            total: z.number().int().min(0).describe('Total users'),
            active30d: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    'Non-disabled, non-deleted users last seen within the past 30 days; omitted when unavailable',
                ),
        }),
        cluster: ClusterGlanceSchema.optional().describe(
            'One-glance cluster summary; omitted when the cluster status could not be read',
        ),
        /** Per-nav-section worst verdict, derived server-side from attention items. */
        sectionStatus: z.record(AdminSectionIdSchema, AttentionVerdictSchema),
    })
    .meta({
        id: 'AdminStatusPayload',
        description: 'Canonical admin status payload — one source of truth for all admin chrome',
    });
export type AdminStatusPayload = z.infer<typeof AdminStatusPayloadSchema>;
