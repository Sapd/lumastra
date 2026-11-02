// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { PushTokenRegistrationSchema } from './push-notifications';

it.each(['bad topic', 'com..app', 'https://user:secret@host', '.app', 'com.app/secret'])(
    'rejects malformed APNs topic %s with a safe, actionable message',
    (bundleId) => {
        const result = PushTokenRegistrationSchema.safeParse({
            token: 'token',
            bundleId,
            environment: 'production',
            payloadVersion: 1,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.message).toMatch(
                /Invalid APNs topic.*bundle identifier/,
            );
            expect(result.error.issues[0]?.message).not.toContain(bundleId);
        }
    },
);

it('accepts the device bundle identifier as its APNs topic', () => {
    expect(
        PushTokenRegistrationSchema.safeParse({
            token: 'token',
            bundleId: 'org.example.my-app',
            environment: 'production',
            payloadVersion: 1,
        }).success,
    ).toBe(true);
});
