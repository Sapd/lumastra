// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native holiday-recommendations feature: every route and the startup hook
 * respect the admin setting (DISABLE_HOLIDAY_RECOMMENDATIONS, off by default).
 * Off means a quiet 200 with nothing in it, and the holiday config is never
 * loaded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';

const initHolidayPlugin = vi.fn();
const getCurrentHoliday = vi.fn();
const getAllHolidays = vi.fn();

vi.mock('../../../../plugins/holidays/plugin.js', () => ({
    initHolidayPlugin: () => initHolidayPlugin(),
    getCurrentHoliday: () => getCurrentHoliday(),
    getAllHolidays: () => getAllHolidays(),
}));

const { holidayRecommendationsFeature } = await import('./holiday-recommendations.js');
const { features } = await import('$lib/server/config.js');

const ctx = {} as PluginContext;
const req = new Request('http://localhost/');

function route(path: string) {
    const r = holidayRecommendationsFeature.routes.find((x) => x.path === path);
    if (!r) throw new Error(`no route ${path}`);
    return r;
}

const halloween = { id: 'halloween', name: 'Halloween' };

beforeEach(() => {
    initHolidayPlugin.mockReset();
    getCurrentHoliday.mockReset().mockReturnValue(halloween);
    getAllHolidays.mockReset().mockReturnValue([halloween]);
});

describe('holiday-recommendations feature, disabled (the default)', () => {
    beforeEach(() => {
        vi.spyOn(features, 'holidays', 'get').mockReturnValue(false);
    });

    it('GET /active → 200 inactive, uncached, plugin untouched', async () => {
        const res = await route('/active').handler(ctx, req, {});
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(await res.json()).toEqual({ active: false, holiday: null });
        expect(initHolidayPlugin).not.toHaveBeenCalled();
    });

    it('GET /all → 200 empty list, plugin untouched', async () => {
        const res = await route('/all').handler(ctx, req, {});
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ holidays: [] });
        expect(initHolidayPlugin).not.toHaveBeenCalled();
    });

    it('onStartup does not load the holiday config', async () => {
        await holidayRecommendationsFeature.onStartup?.(ctx);
        expect(initHolidayPlugin).not.toHaveBeenCalled();
    });
});

describe('holiday-recommendations feature, enabled', () => {
    beforeEach(() => {
        vi.spyOn(features, 'holidays', 'get').mockReturnValue(true);
    });

    it('GET /active → the current holiday', async () => {
        const res = await route('/active').handler(ctx, req, {});
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ active: true, holiday: halloween });
    });

    it('GET /all → every holiday', async () => {
        const res = await route('/all').handler(ctx, req, {});
        expect(await res.json()).toEqual({ holidays: [halloween] });
    });

    it('onStartup loads the holiday config', async () => {
        await holidayRecommendationsFeature.onStartup?.(ctx);
        expect(initHolidayPlugin).toHaveBeenCalledTimes(1);
    });
});
