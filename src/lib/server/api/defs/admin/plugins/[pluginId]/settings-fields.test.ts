// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which settings keys an operator may write.
 *
 * The handler drops any key the plugin did not declare, which is right — until
 * the HOST is the thing requiring a key. A webhook-capable integration needs a
 * `webhookSecret` before its endpoint answers anything but 404, and nothing
 * makes the author declare a field for it, so before this the operator had no
 * way to turn that webhook on and no remedy at all.
 */

import { describe, it, expect } from 'vitest';
import { def, checkSettingFieldValue, effectiveSettingsFields } from './settings.js';

describe('webhookSecret injection', () => {
    it('is offered to a webhook-capable integration that never declared it', () => {
        const fields = effectiveSettingsFields([{ key: 'apiKey', type: 'secret' }], true);
        expect(fields.has('webhookSecret')).toBe(true);
        expect(fields.get('webhookSecret')?.type).toBe('secret');
    });

    it('is NOT offered to a plugin without the webhook capability', () => {
        const fields = effectiveSettingsFields([{ key: 'apiKey', type: 'secret' }], false);
        expect(fields.has('webhookSecret')).toBe(false);
    });

    it('never overwrites a field the plugin declared itself', () => {
        const declared = { key: 'webhookSecret', type: 'secret', label: "Author's own label" };
        const fields = effectiveSettingsFields([declared], true);
        expect(fields.get('webhookSecret')).toBe(declared);
    });

    it('leaves the declared fields otherwise untouched', () => {
        const fields = effectiveSettingsFields(
            [
                { key: 'a', type: 'string' },
                { key: 'b', type: 'number' },
            ],
            true,
        );
        expect([...fields.keys()].sort()).toEqual(['a', 'b', 'webhookSecret']);
    });

    it('handles a plugin with no declared fields at all', () => {
        expect(effectiveSettingsFields([], true).has('webhookSecret')).toBe(true);
        expect(effectiveSettingsFields([], false).size).toBe(0);
    });
});

describe('array field values', () => {
    it('stores the admin form text as a real list of trimmed names', async () => {
        const { normalizeArrayValue } = await import('./settings.js');
        expect(normalizeArrayValue('admins, family ,, ')).toEqual(['admins', 'family']);
        expect(normalizeArrayValue(['a', ' b ', ''])).toEqual(['a', 'b']);
        expect(normalizeArrayValue('')).toEqual([]);
        expect(normalizeArrayValue(null)).toEqual([]);
    });
});

describe('checkSettingFieldValue', () => {
    it('coerces a numeric string for a number field so min/max apply to it', () => {
        expect(checkSettingFieldValue({ key: 'rps', type: 'number' }, '0.5')).toEqual({
            ok: true,
            value: 0.5,
        });
        expect(checkSettingFieldValue({ key: 'rps', type: 'number' }, 'fast').ok).toBe(false);
        expect(checkSettingFieldValue({ key: 'rps', type: 'number' }, { n: 1 }).ok).toBe(false);
    });

    it('refuses a select value the field never offered', () => {
        const field = { key: 'mode', type: 'select', options: [{ value: 'a' }, { value: 'b' }] };
        expect(checkSettingFieldValue(field, 'b').ok).toBe(true);
        expect(checkSettingFieldValue(field, 'c').ok).toBe(false);
    });

    it('requires real booleans and strings, and still lets null clear a value', () => {
        expect(checkSettingFieldValue({ key: 'on', type: 'boolean' }, 'true').ok).toBe(false);
        expect(checkSettingFieldValue({ key: 'name', type: 'string' }, 42).ok).toBe(false);
        expect(checkSettingFieldValue({ key: 'on', type: 'boolean' }, null).ok).toBe(true);
    });
});


describe('reserved core server identity', () => {
    it('rejects the plugin-settings write API before registry or database access', async () => {
        const response = await def.handlers.PUT!({ params: { pluginId: 'core.server' } } as never,
            { surface: 'internal' });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'forbidden' });
    });
});
