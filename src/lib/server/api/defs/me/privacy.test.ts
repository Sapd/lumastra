// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { def } from './privacy.js';
import { SharingPolicySchema } from '$lib/schemas/api-content-responses.js';

const spec = parse(readFileSync('docs/api/api-v1.yaml', 'utf8'), { maxAliasCount: -1 }) as {
    paths: Record<
        string,
        Record<
            string,
            {
                operationId: string;
                tags: string[];
                'x-stability': string;
            }
        >
    >;
    components: { schemas: Record<string, { properties: Record<string, unknown> }> };
};

describe('public app privacy contract', () => {
    it.each([
        ['get', 'getMyPrivacy'],
        ['patch', 'updateMyPrivacy'],
    ])('%s /me/privacy is stable and grouped under Me', (method, operationId) => {
        expect(spec.paths['/api/v1/me/privacy'][method]).toMatchObject({
            operationId,
            tags: ['Me'],
            'x-stability': 'stable',
        });
    });

    it('publishes the closed listening-sharing blockedBy enum used by app hints', () => {
        const values = ['global_sharing_off', 'hidden', 'item_opted_out', 'no_audience'];
        expect(SharingPolicySchema.shape.blockedBy.safeParse(values).success).toBe(true);
        expect(SharingPolicySchema.shape.blockedBy.safeParse(['unknown_blocker']).success).toBe(
            false,
        );
        expect(spec.components.schemas.SharingPolicy.properties.blockedBy).toEqual({
            type: 'array',
            items: { type: 'string', enum: values },
        });
    });
});

describe('privacy authentication', () => {
    it('uses the authenticated-user policy shared by self preferences', () => {
        expect(def.auth).toEqual({ kind: 'user' });
    });
});
