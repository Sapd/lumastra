// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plugins page must not call holiday recommendations "Active" while the
 * admin setting has them off (the default since v0.1); it links to the switch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { featureSwitchOff } from './plugin-setup-status.js';
import { features } from '$lib/server/config.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('featureSwitchOff', () => {
    it('holiday-recommendations is off by default and links to its setting', () => {
        expect(features.holidays).toBe(false);
        expect(featureSwitchOff('holiday-recommendations')).toEqual({
            status: 'off',
            href: '/admin/settings/tasks?section=advanced-tasks&highlight=DISABLE_HOLIDAY_RECOMMENDATIONS',
        });
    });

    it('returns undefined once the admin turns it on', () => {
        vi.spyOn(features, 'holidays', 'get').mockReturnValue(true);
        expect(featureSwitchOff('holiday-recommendations')).toBeUndefined();
    });

    it('returns undefined for a feature without a switch', () => {
        expect(featureSwitchOff('dummy')).toBeUndefined();
    });
});
