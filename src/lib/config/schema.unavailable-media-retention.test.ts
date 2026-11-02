// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { configSchema, validateSettingValue } from './schema.js';

describe('unavailable media retention setting', () => {
    it('preserves the existing window and allows a shorter window in Advanced Tasks', () => {
        const setting = configSchema.find((s) => s.key === 'UNAVAILABLE_MEDIA_RETENTION_DAYS');
        expect(setting).toMatchObject({
            defaultValue: 30,
            section: 'advanced-tasks',
            type: 'number',
        });
        if (!setting) throw new Error('Missing retention setting');
        expect(validateSettingValue(setting, 14).valid).toBe(true);
        expect(validateSettingValue(setting, 0).valid).toBe(true);
        expect(validateSettingValue(setting, -1).valid).toBe(false);
        expect(validateSettingValue(setting, 3650).valid).toBe(true);
        expect(validateSettingValue(setting, 3651).valid).toBe(false);
        expect(setting.description).toContain('0 to disable');
        expect(validateSettingValue(setting, 1.5).valid).toBe(false);
    });
});
