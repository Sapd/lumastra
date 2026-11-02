// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import type { ZodType } from 'zod';
import { def } from './reload.js';
import { def as uninstallDef } from './uninstall.js';

// Narrow a ResponseDef union to the { schema } variant so `.schema` is typed
// without any suppression (the union also admits `string`, `binary`, etc.).
function responseSchema(defEntry: unknown): ZodType {
    if (typeof defEntry !== 'object' || defEntry === null || !('schema' in defEntry)) {
        throw new Error('expected a schema response variant');
    }
    const s = (defEntry as { schema: unknown }).schema;
    return s as ZodType;
}

describe('POST /plugins/external/{id}/reload def', () => {
    it('response schema includes reloaded + restartRequired', () => {
        const s = responseSchema(def.docs!.POST!.responses[200]);
        expect(s.safeParse({ id: 'p', reloaded: false, restartRequired: true }).success).toBe(true);
        expect(
            s.safeParse({ id: 'p', reloaded: true, version: '1.0.0', restartRequired: false })
                .success,
        ).toBe(true);
    });
    it('declares a 404 response', () => {
        expect(def.docs!.POST!.responses[404]).toBeDefined();
    });
});

describe('POST /plugins/external/{id}/uninstall def', () => {
    it('200 schema pins uninstalled + restartRequired literals', () => {
        const s = responseSchema(uninstallDef.docs!.POST!.responses[200]);
        expect(s.safeParse({ id: 'p', uninstalled: true, restartRequired: true }).success).toBe(
            true,
        );
        expect(s.safeParse({ id: 'p', uninstalled: false, restartRequired: true }).success).toBe(
            false,
        );
    });
    it('500 schema carries a warning string', () => {
        const s = responseSchema(uninstallDef.docs!.POST!.responses[500]);
        expect(
            s.safeParse({ id: 'p', uninstalled: true, restartRequired: true, warning: 'boom' })
                .success,
        ).toBe(true);
    });
    it('declares a 404 response', () => {
        expect(uninstallDef.docs!.POST!.responses[404]).toBeDefined();
    });
});
