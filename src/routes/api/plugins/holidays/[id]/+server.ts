// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Plugin API - Single Holiday Operations
 *
 * GET    /api/plugins/holidays/[id] - Get single holiday
 * PUT    /api/plugins/holidays/[id] - Update holiday
 * DELETE /api/plugins/holidays/[id] - Delete holiday
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
import type { HolidayConfig, HolidayPluginConfig } from '$lib/server/plugins/holidays/types';
import { Logger } from '$lib/server/utils/logger';
import { holidayUpdateBodySchema } from '$lib/schemas/holidays';
import {
    HolidayMutationResponseSchema,
    HolidayDeleteResponseSchema,
} from '$lib/schemas/api-admin-responses.js';

const logger = Logger.for('HolidayAPI');

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: holidayUpdateBodySchema,
    },
    handlers: {
        /**
         * GET /api/plugins/holidays/[id]
         * Returns a single holiday by ID.
         */
        GET: async (event, _ctx) => {
            const id = event.params.id ?? '';
            const config = getHolidayConfig();
            const holiday = config.holidays.find((h) => h.id === id);

            if (!holiday) {
                return ApiProblem.notFound(`Holiday "${id}" not found`);
            }

            return json(HolidayMutationResponseSchema.parse({ holiday }));
        },

        /**
         * PUT /api/plugins/holidays/[id]
         * Updates an existing holiday (all fields optional).
         */
        PUT: async (event, ctx) => {
            const id = event.params.id ?? '';
            const updates = ctx.input!.body;

            const config = getHolidayConfig();
            const index = config.holidays.findIndex((h) => h.id === id);

            if (index === -1) {
                return ApiProblem.notFound(`Holiday "${id}" not found`);
            }

            const existingHoliday = config.holidays[index];

            const updatedHoliday: HolidayConfig = {
                ...existingHoliday,
                ...updates,
                // Ensure ID cannot be changed
                id: existingHoliday.id,
                // Handle nested objects properly
                sources: updates.sources ?? existingHoliday.sources,
                preHoliday:
                    updates.preHoliday !== undefined
                        ? (updates.preHoliday ?? undefined)
                        : existingHoliday.preHoliday,
                validation:
                    updates.validation !== undefined
                        ? (updates.validation ?? undefined)
                        : existingHoliday.validation,
            };

            const updatedHolidays = [...config.holidays];
            updatedHolidays[index] = updatedHoliday;

            const newConfig: HolidayPluginConfig = {
                settings: config.settings,
                holidays: updatedHolidays,
            };

            const saved = saveHolidayConfig(newConfig);
            if (!saved) {
                return ApiProblem.dependencyUnavailable('Configuration file could not be written');
            }

            reloadConfig();

            logger.info('Holiday updated', { id, name: updatedHoliday.name });

            return json(HolidayMutationResponseSchema.parse({ holiday: updatedHoliday }));
        },

        /**
         * DELETE /api/plugins/holidays/[id]
         * Deletes a holiday.
         */
        DELETE: async (event, _ctx) => {
            const id = event.params.id ?? '';
            const config = getHolidayConfig();
            const index = config.holidays.findIndex((h) => h.id === id);

            if (index === -1) {
                return ApiProblem.notFound(`Holiday "${id}" not found`);
            }

            const deletedHoliday = config.holidays[index];

            const newConfig: HolidayPluginConfig = {
                settings: config.settings,
                holidays: config.holidays.filter((h) => h.id !== id),
            };

            const saved = saveHolidayConfig(newConfig);
            if (!saved) {
                return ApiProblem.dependencyUnavailable('Configuration file could not be written');
            }

            reloadConfig();

            logger.info('Holiday deleted', { id, name: deletedHoliday.name });

            return json(HolidayDeleteResponseSchema.parse({ deleted: true, id }));
        },
    },
});

export const { GET, PUT, DELETE } = mount(def, { surface: 'internal' });
