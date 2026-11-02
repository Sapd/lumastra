// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { ResponseDef } from '$lib/server/openapi';
import { def } from './index.js';

/** Narrow a `ResponseDef` to its `{schema}` variant, failing loudly otherwise. */
function schemaOf(d: ResponseDef) {
    if (typeof d === 'string' || !('schema' in d)) {
        throw new Error('Expected a { schema } response definition');
    }
    return d.schema;
}

describe('GET /plugins/external def', () => {
    it('declares the enriched item schema (loaded + restartRequired + status)', () => {
        const schema = schemaOf(def.docs!.GET!.responses[200]);
        const parsed = schema.safeParse({
            plugins: [
                {
                    id: 'p',
                    version: '1.0.0',
                    enabled: true,
                    status: 'installed',
                    loaded: true,
                    restartRequired: false,
                },
            ],
        });
        expect(parsed.success).toBe(true);
    });

    it('accepts signingKeyId + signingKeySource including unknown for a NULL-keyId row', () => {
        const schema = schemaOf(def.docs!.GET!.responses[200]);
        expect(
            schema.safeParse({
                plugins: [
                    {
                        id: 'p',
                        version: '1.0.0',
                        enabled: true,
                        status: 'installed',
                        loaded: true,
                        restartRequired: false,
                        signingKeyId: 'ops',
                        signingKeySource: 'operator',
                    },
                    {
                        id: 'q',
                        version: '1.0.0',
                        enabled: true,
                        status: 'installed',
                        loaded: true,
                        restartRequired: false,
                        signingKeySource: 'unknown',
                    },
                ],
            }).success,
        ).toBe(true);
    });
});
