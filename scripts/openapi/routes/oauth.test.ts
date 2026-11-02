// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { oauthRoutes } from './oauth';
import { deviceCodeRequestSchema } from '../../../src/lib/schemas/oauth';

const device = oauthRoutes['/oauth/device']!;
const token = oauthRoutes['/oauth/token']!;

describe('OAuth documentation matches runtime contracts', () => {
    it('reuses the device request schema including device_id for JSON and forms', () => {
        const body = device.post!.requestBody;
        if (!body || !('content' in body)) throw new Error('Missing request content');
        for (const type of ['application/json', 'application/x-www-form-urlencoded']) {
            expect(body.content[type].schema).toBe(deviceCodeRequestSchema);
            expect(
                deviceCodeRequestSchema.parse({ client_id: 'client', device_id: 'device' }),
            ).toEqual({ client_id: 'client', device_id: 'device' });
        }
    });

    it('requires the fields of each token grant and supports both encodings', () => {
        const body = token.post!.requestBody;
        if (!body || !('content' in body)) throw new Error('Missing request content');
        for (const type of ['application/json', 'application/x-www-form-urlencoded']) {
            const schema = body.content[type].schema as z.ZodType;
            expect(
                schema.safeParse({ grant_type: 'refresh_token', refresh_token: 'refresh' }).success,
            ).toBe(true);
            expect(schema.safeParse({ grant_type: 'refresh_token' }).success).toBe(false);
            expect(
                schema.safeParse({
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    device_code: 'device',
                    client_id: 'client',
                }).success,
            ).toBe(true);
            expect(
                schema.safeParse({
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    device_code: 'device',
                }).success,
            ).toBe(false);
        }
    });

    it('documents the unauthenticated HEAD probe and stable operations', () => {
        expect(device.head!.security).toEqual([]);
        expect(Object.keys(device.head!.responses!)).toEqual(['200', '400']);
        for (const operation of [device.head!, device.post!, token.post!]) {
            expect(operation['x-stability']).toBe('stable');
            expect(operation.security).toEqual([]);
        }
        expect(device.post!.responses).toHaveProperty('400');
        expect(token.post!.responses).toHaveProperty('429');
    });
});
