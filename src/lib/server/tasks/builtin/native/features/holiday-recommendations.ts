// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Recommendations feature plugin.
 *
 * Route handlers delegate to plugins/holidays/plugin.ts, which owns the
 * holiday data pipeline and its $lib imports.
 *
 * Routes: GET /active · GET /all (recommendations themselves are served by
 * /api/recommendations/holiday, which has the caller's access boundary).
 */

import { defineFeature } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import type { HolidayConfig } from '../../../../plugins/holidays/types.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('holiday-recommendations');

export const holidayRecommendationsFeature = defineFeature({
    id: 'holiday-recommendations',

    routes: [
        // No `GET /` recommendations route: this plugin surface has no access
        // to the caller's library/age boundary (it used to trust a client-sent
        // username header and served unscoped, ungated results). The web UI
        // and apps use /api/recommendations/holiday and the editorial rail.
        {
            method: 'GET',
            path: '/active',
            handler: async (_ctx, _req) => {
                if (!features.holidays) {
                    // No-store: turning the setting on must take effect at once.
                    return Response.json(
                        { active: false, holiday: null },
                        { headers: { 'Cache-Control': 'no-store' } },
                    );
                }

                try {
                    const { getCurrentHoliday, initHolidayPlugin } =
                        await import('../../../../plugins/holidays/plugin.js');
                    initHolidayPlugin();
                    const holiday: HolidayConfig | null = getCurrentHoliday();
                    return Response.json(
                        { active: holiday !== null, holiday },
                        { headers: { 'Cache-Control': 'public, max-age=3600' } },
                    );
                } catch (err) {
                    logger.warn('holiday-recommendations: GET /active failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return Response.json(
                        { error: 'Failed to get active holiday' },
                        { status: 500 },
                    );
                }
            },
        },
        {
            method: 'GET',
            path: '/all',
            handler: async (_ctx, _req) => {
                if (!features.holidays) {
                    return Response.json(
                        { holidays: [] },
                        { headers: { 'Cache-Control': 'no-store' } },
                    );
                }
                try {
                    const { getAllHolidays, initHolidayPlugin } =
                        await import('../../../../plugins/holidays/plugin.js');
                    initHolidayPlugin();
                    const holidays = getAllHolidays();
                    return Response.json(
                        { holidays },
                        {
                            headers: {
                                'Cache-Control': 'public, max-age=86400',
                            },
                        },
                    );
                } catch (err) {
                    logger.warn('holiday-recommendations: GET /all failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return Response.json({ error: 'Failed to get all holidays' }, { status: 500 });
                }
            },
        },
    ],

    settings: {
        fields: [
            {
                key: 'defaultLimit',
                type: 'number',
                label: 'Default Limit',
                description: 'Maximum number of recommendations to show per holiday',
                default: 20,
                validation: { min: 1, max: 100 },
            },
            {
                key: 'enableAiPersonalization',
                type: 'boolean',
                label: 'AI Personalization',
                description: 'Use AI to personalize recommendations based on user preferences',
                default: true,
            },
            {
                key: 'cacheTtlMinutes',
                type: 'number',
                label: 'Cache TTL (minutes)',
                description: 'How long to cache recommendation results',
                default: 30,
                validation: { min: 1, max: 1440 },
            },
        ],
    },

    async onStartup(_ctx) {
        // Off (the default): don't load the config or start the dev file
        // poller. Every entry point inits lazily once the setting is on.
        if (!features.holidays) return;
        const { initHolidayPlugin } = await import('../../../../plugins/holidays/plugin.js');
        initHolidayPlugin();
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerFeature(holidayRecommendationsFeature);
