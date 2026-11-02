// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Plugin API - List and Create
 *
 * GET  /api/plugins/holidays - List all holidays
 * POST /api/plugins/holidays - Create new holiday
 *
 * Deliberately NOT gated by features.holidays (DISABLE_HOLIDAY_RECOMMENDATIONS):
 * these admin-only routes edit the holiday config and serve no
 * recommendations, so an admin can prepare it before turning the feature on.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
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
import { holidayCreateBodySchema } from '$lib/schemas/holidays';
import {
    HolidaysListResponseSchema,
    HolidayMutationResponseSchema,
} from '$lib/schemas/api-admin-responses.js';

const logger = Logger.for('HolidayAPI');

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        /**
         * GET /api/plugins/holidays
         * Returns all configured holidays and global settings.
         */
        GET: async (_event, _ctx) => {
            const config = getHolidayConfig();
            return json(
                HolidaysListResponseSchema.parse({
                    holidays: config.holidays,
                    settings: config.settings,
                }),
            );
        },

        /**
         * POST /api/plugins/holidays
         * Creates a new holiday configuration.
         */
        POST: async (event, _ctx) => {
            const raw: unknown = await readBoundedJson(event.request).catch(() => null);
            const bodyResult = holidayCreateBodySchema.safeParse(raw);
            if (!bodyResult.success) {
                return ApiProblem.validationFailed(
                    bodyResult.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const holiday = bodyResult.data;

            const config = getHolidayConfig();

            if (config.holidays.some((h) => h.id === holiday.id)) {
                return ApiProblem.conflict(`A holiday with ID "${holiday.id}" already exists`);
            }

            const newHoliday: HolidayConfig = {
                id: holiday.id,
                name: holiday.name,
                localizedNames: holiday.localizedNames,
                emoji: holiday.emoji || '\u{1F4C5}',
                startMonth: holiday.startMonth,
                startDay: holiday.startDay,
                endMonth: holiday.endMonth,
                endDay: holiday.endDay,
                sources: holiday.sources,
                backgroundColor: holiday.backgroundColor || '#333333',
                textColor: holiday.textColor || '#FFFFFF',
                backgroundImage: holiday.backgroundImage,
                preHoliday: holiday.preHoliday,
                validation: holiday.validation,
                enabled: holiday.enabled ?? true,
                priority: holiday.priority ?? 0,
            };

            const newConfig: HolidayPluginConfig = {
                settings: config.settings,
                holidays: [...config.holidays, newHoliday],
            };

            const saved = saveHolidayConfig(newConfig);
            if (!saved) {
                return ApiProblem.dependencyUnavailable('Configuration file could not be written');
            }

            reloadConfig();

            logger.info('Holiday created', {
                id: newHoliday.id,
                name: newHoliday.name,
            });

            return json(HolidayMutationResponseSchema.parse({ holiday: newHoliday }), {
                status: 201,
            });
        },
    },
});

export const { GET, POST } = mount(def, { surface: 'internal' });
