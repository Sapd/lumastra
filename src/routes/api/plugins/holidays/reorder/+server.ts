// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Plugin API - Reorder
 *
 * POST /api/plugins/holidays/reorder - Reorder holidays
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    getHolidayConfig,
    saveHolidayConfig,
    reloadConfig,
} from '$lib/server/plugins/holidays/config-loader';
import type { HolidayPluginConfig } from '$lib/server/plugins/holidays/types';
import { Logger } from '$lib/server/utils/logger';
import { holidayReorderBodySchema } from '$lib/schemas/holidays';
import { HolidayReorderResponseSchema } from '$lib/schemas/api-admin-responses.js';

const logger = Logger.for('HolidayAPI');

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: holidayReorderBodySchema,
    },
    handlers: {
        /**
         * POST /api/plugins/holidays/reorder
         * Reorders holidays based on provided order array.
         */
        POST: async (_event, ctx) => {
            const { order } = ctx.input!.body;

            const config = getHolidayConfig();

            // Build reordered holidays array
            const reorderedHolidays = [];
            const seenIds = new Set<string>();

            // First, add holidays in the specified order
            for (const id of order) {
                const holiday = config.holidays.find((h) => h.id === id);
                if (holiday && !seenIds.has(id)) {
                    reorderedHolidays.push(holiday);
                    seenIds.add(id);
                }
            }

            // Then, add any holidays not in the order array (to prevent data loss)
            for (const holiday of config.holidays) {
                if (!seenIds.has(holiday.id)) {
                    reorderedHolidays.push(holiday);
                    seenIds.add(holiday.id);
                }
            }

            const newConfig: HolidayPluginConfig = {
                settings: config.settings,
                holidays: reorderedHolidays,
            };

            const saved = saveHolidayConfig(newConfig);
            if (!saved) {
                return ApiProblem.dependencyUnavailable('Configuration file could not be written');
            }

            reloadConfig();

            logger.info('Holidays reordered', {
                order: reorderedHolidays.map((h) => h.id),
            });

            return json(
                HolidayReorderResponseSchema.parse({
                    order: reorderedHolidays.map((h) => h.id),
                }),
            );
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
