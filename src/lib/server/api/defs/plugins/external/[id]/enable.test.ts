// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import type { ZodType } from 'zod';
import { def } from './enable.js';
import { def as disableDef } from './disable.js';
import { ID_PATTERN } from '$lib/server/tasks/registry.js';

// Narrow a ResponseDef union to the { schema } variant so `.schema` is typed
// without any suppression (the union also admits `string`, `binary`, etc.).
function responseSchema(def200: unknown): ZodType {
    if (typeof def200 !== 'object' || def200 === null || !('schema' in def200)) {
        throw new Error('expected a schema response variant');
    }
    const s = (def200 as { schema: unknown }).schema;
    return s as ZodType;
}

describe('POST /plugins/external/{id}/enable def', () => {
    it('response schema includes loaded + restartRequired', () => {
        const s = responseSchema(def.docs!.POST!.responses[200]);
        expect(
            s.safeParse({ id: 'p', enabled: true, loaded: true, restartRequired: false }).success,
        ).toBe(true);
    });
    it('declares a 404 response', () => {
        expect(def.docs!.POST!.responses[404]).toBeDefined();
    });
    it('ID_PATTERN rejects traversal ids', () => {
        expect(ID_PATTERN.test('../../etc')).toBe(false);
        expect(ID_PATTERN.test('sample-plugin')).toBe(true);
    });
});

describe('POST /plugins/external/{id}/disable def', () => {
    it('response schema pins enabled:false + restartRequired:true', () => {
        const s = responseSchema(disableDef.docs!.POST!.responses[200]);
        expect(s.safeParse({ id: 'p', enabled: false, restartRequired: true }).success).toBe(true);
        expect(s.safeParse({ id: 'p', enabled: true, restartRequired: true }).success).toBe(false);
    });
    it('declares a 404 response', () => {
        expect(disableDef.docs!.POST!.responses[404]).toBeDefined();
    });
});
