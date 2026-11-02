// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * Wire shape of GET /api/v1/integrations/homepage — a read-only summary built for
 * gethomepage.dev's generic `customapi` widget. That widget can neither merge calls
 * nor join fields, so this payload carries flat numbers for its block view and
 * ready-made `name`/`label` strings for its `dynamic-list` view.
 */

export const HomepageListItemSchema = z
    .object({
        name: z.string().describe('Left side of a dynamic-list row'),
        label: z.string().describe('Right side of a dynamic-list row'),
    })
    .meta({ id: 'HomepageListItem', description: 'One dynamic-list row' });
export type HomepageListItem = z.infer<typeof HomepageListItemSchema>;

export const HomepageRecentItemSchema = z
    .object({
        name: z
            .string()
            .describe('Display title; movies carry their year: "The Last Signal (2021)"'),
        addedAt: z
            .string()
            .describe('ISO timestamp the item was added; render with format: relativeDate'),
    })
    .meta({ id: 'HomepageRecentItem', description: 'One recently added item' });
export type HomepageRecentItem = z.infer<typeof HomepageRecentItemSchema>;

export const HomepageHealthSchema = z
    .enum(['ok', 'degraded', 'down'])
    .describe('ok = all components pass; down = database or valkey failing; degraded otherwise')
    .meta({ id: 'HomepageHealth' });
export type HomepageHealth = z.infer<typeof HomepageHealthSchema>;

const count = z.number().int().min(0);

export const HomepageSummarySchema = z
    .object({
        generatedAt: z.string().describe('ISO timestamp the snapshot was built'),
        summary: z.object({
            streams: count.describe('Active playback sessions'),
            transcodes: count.describe('Sessions being transcoded'),
            directPlays: count.describe(
                'Sessions not being transcoded (direct play, direct stream or remux)',
            ),
            users: count.describe('Distinct users currently playing'),
            bandwidthMbps: z.number().min(0).describe('Aggregate bandwidth served, Mbps'),
            nodesUp: count.describe('Cluster nodes with a live heartbeat'),
            nodesExpected: count.describe('Cluster nodes expected online'),
            tasksRunning: count.describe(
                'Task runs active or cancelling (exact; the `tasks` list is capped)',
            ),
            tasksQueued: count.describe('Jobs waiting in the task queues'),
            tasksFailed24h: count.describe('Task runs that failed in the last 24 hours'),
            alerts: count.describe('Number of alerts (the `alerts` list shows at most 10)'),
            health: HomepageHealthSchema,
            version: z.string().describe('Server version'),
        }),
        sessions: z.array(HomepageListItemSchema).describe('Now playing, newest first (max 10)'),
        nodes: z.array(HomepageListItemSchema).describe('Cluster nodes (max 10)'),
        tasks: z.array(HomepageListItemSchema).describe('Running task runs (max 10)'),
        alerts: z
            .array(HomepageListItemSchema)
            .describe(
                'Components not passing, missing cluster nodes, paused queues, and summary sections that could not be read (max 10)',
            ),
        library: z.object({
            movies: count,
            series: count,
            episodes: count,
            artists: count,
            albums: count,
            tracks: count,
            audiobooks: count,
        }),
        recentlyAdded: z
            .array(HomepageRecentItemSchema)
            .describe(
                "Newest top-level movies, series and audiobooks, by library add time (max 10) — the same items as the app's Recently added row",
            ),
    })
    .meta({
        id: 'HomepageSummary',
        description: 'Server summary for the gethomepage.dev customapi widget',
    });
export type HomepageSummary = z.infer<typeof HomepageSummarySchema>;
