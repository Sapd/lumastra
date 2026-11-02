// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { PushTokenRegistrationSchema } from '$lib/schemas/push-notifications.js';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Mirrors devices.defs.test.ts's harness: stub every dependency the def pulls
// in so mount()/enforce() can drive real PUT/DELETE handlers without a DB.

const { mockLoggerInfo } = vi.hoisted(() => ({ mockLoggerInfo: vi.fn() }));

vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_DEVICE_AUTH: true } as Record<string, unknown>,
    features: {} as Record<string, unknown>,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: mockLoggerInfo,
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(),
}));

vi.mock('$lib/server/database/queries/user-devices.queries.js', () => ({
    getDeviceIdForSession: vi.fn(),
    // The text client id from getDeviceIdForSession is NOT the uuid that
    // user_push_tokens.device_id references — this hop is what translates it.
    // See the "two device_id columns" note in migration 16.200.0.
    getUserDeviceByDeviceId: vi.fn(),
    sessionBelongsToUser: vi.fn(),
}));

vi.mock('$lib/server/database/queries/user-push-tokens.queries.js', () => ({
    upsertPushToken: vi.fn(),
    deletePushTokenForDevice: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getDeviceIdForSession,
    getUserDeviceByDeviceId,
    sessionBelongsToUser,
} from '$lib/server/database/queries/user-devices.queries.js';
import {
    upsertPushToken,
    deletePushTokenForDevice,
} from '$lib/server/database/queries/user-push-tokens.queries.js';
import { def } from './index.js';

describe('PushTokenRegistrationSchema', () => {
    it('accepts a well-formed registration', () => {
        const parsed = PushTokenRegistrationSchema.safeParse({
            token: 'a'.repeat(64),
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'de-DE',
            payloadVersion: 1,
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects an unknown environment', () => {
        const parsed = PushTokenRegistrationSchema.safeParse({
            token: 'a'.repeat(64),
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'staging',
            locale: 'en-US',
            payloadVersion: 1,
        });
        expect(parsed.success).toBe(false);
    });

    it('rejects an empty token', () => {
        const parsed = PushTokenRegistrationSchema.safeParse({
            token: '',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        expect(parsed.success).toBe(false);
    });
});

describe('push-token def', () => {
    it('is gated behind FEATURE_DEVICE_AUTH then user auth', () => {
        expect(def.auth).toEqual({
            kind: 'feature',
            flag: 'DEVICE_AUTH',
            then: { kind: 'user' },
        });
    });

    it('exposes PUT and DELETE only', () => {
        expect(Object.keys(def.handlers).sort()).toEqual(['DELETE', 'PUT']);
    });
});

// ── mount()-driven behavioural tests ──────────────────────────────────────────
//
// The tests above only check the def's static shape — they'd pass against a
// handler gutted to always return 200. These drive the real PUT/DELETE
// handlers through mount() + enforce(), covering ownership branches, the
// manual body-validation path (see index.ts's comment on why there's no
// def-level `request.body`), and the DELETE-with-no-body regression this
// endpoint exists to guard.

const CTX = { surface: 'v1' as const };
const DEVICE_SESSION_ID = 'session-abc';
/** `user_devices.id` — the uuid the push-token tables actually reference. */
const DEVICE_UUID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

/** A callable double standing in for `postgres.Sql` — used as a tagged
 *  template in DELETE's honest-environment lookup; unused (but must stay
 *  truthy) for PUT, which never touches `sql` directly. */
function makeFakeSql(rows: Array<{ environment: 'sandbox' | 'production' }> = []): postgres.Sql {
    return vi.fn().mockResolvedValue(rows) as unknown as postgres.Sql;
}

function makeEvent(
    opts: {
        username?: string;
        params?: Record<string, string>;
        method?: string;
        rawBody?: string | null;
    } = {},
): RequestEvent {
    const user = opts.username
        ? {
              userId: toUserId('00000000-0000-0000-0000-000000000001'),
              username: opts.username,
              groups: '',
              userGroups: [] as string[],
              hasWatchPermission: false,
              hasLiveTvPermission: false,
              hasRequestPermission: false,
              isAdmin: false,
              isModerator: false,
              maxAgeRating: null as null | number,
              isAgeRestricted: false,
              liveTvPriority: 'low' as const,
          }
        : null;

    const url = `http://localhost/api/v1/devices/${DEVICE_SESSION_ID}/push-token`;
    const bodyStr = opts.rawBody ?? null;

    return {
        url: new URL(url),
        request: new Request(url, {
            method: opts.method ?? 'PUT',
            body: bodyStr,
            headers: bodyStr ? { 'content-type': 'application/json' } : undefined,
        }),
        params: opts.params ?? { id: DEVICE_SESSION_ID },
        route: { id: '/api/v1/devices/[id]/push-token' as const },
        locals: { user },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const VALID_BODY = {
    token: 'a'.repeat(64),
    bundleId: 'de.hinterthaner.stellar-tvos.ios',
    environment: 'production' as const,
    locale: 'de-DE',
    payloadVersion: 1,
};

async function bodyOf<T = Record<string, unknown>>(res: Response): Promise<T> {
    return (await res.clone().json()) as T;
}

describe('push-token PUT/DELETE behaviour', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(getDb).mockReturnValue(makeFakeSql());
        // Default: the device row exists. `id` is the uuid PK of user_devices;
        // `device_id` is the client-generated text the session resolves to.
        vi.mocked(getUserDeviceByDeviceId).mockResolvedValue({
            id: DEVICE_UUID,
            device_id: 'device-123',
        } as never);
    });

    it('PUT with a session belonging to another user returns 404 without revealing it exists', async () => {
        vi.mocked(getDeviceIdForSession).mockResolvedValue(null);
        vi.mocked(sessionBelongsToUser).mockResolvedValue(false);

        const { PUT } = mount(def, CTX);
        const res = await PUT!(
            makeEvent({ username: 'alice', rawBody: JSON.stringify(VALID_BODY) }),
        );

        expect(res.status).toBe(404);
        const body = await bodyOf<{ code: string; error: string }>(res);
        expect(body.code).toBe('not_found');
        // Same generic message as a genuinely nonexistent session — no
        // "this session belongs to someone else" leak.
        expect(body.error).toBe('Device session not found');
        expect(upsertPushToken).not.toHaveBeenCalled();
    });

    it("PUT with the caller's own session that has no linked device returns 409", async () => {
        vi.mocked(getDeviceIdForSession).mockResolvedValue(null);
        vi.mocked(sessionBelongsToUser).mockResolvedValue(true);

        const { PUT } = mount(def, CTX);
        const res = await PUT!(
            makeEvent({ username: 'alice', rawBody: JSON.stringify(VALID_BODY) }),
        );

        expect(res.status).toBe(409);
        const body = await bodyOf<{ code: string }>(res);
        expect(body.code).toBe('conflict');
        expect(upsertPushToken).not.toHaveBeenCalled();
    });

    it('PUT with a malformed body returns 422 with field-level details', async () => {
        const { PUT } = mount(def, CTX);
        const res = await PUT!(
            makeEvent({
                username: 'alice',
                rawBody: JSON.stringify({ bundleId: 'de.hinterthaner.stellar-tvos.ios' }), // missing token/environment/payloadVersion
            }),
        );

        expect(res.status).toBe(422);
        const body = await bodyOf<{ code: string; details?: Array<{ field: string }> }>(res);
        expect(body.code).toBe('validation_failed');
        expect(body.details).toBeDefined();
        const fields = (body.details ?? []).map((d) => d.field);
        expect(fields).toContain('token');
        expect(getDeviceIdForSession).not.toHaveBeenCalled();
    });

    it('PUT with a body that is not valid JSON returns 422', async () => {
        const { PUT } = mount(def, CTX);
        const res = await PUT!(makeEvent({ username: 'alice', rawBody: '{not valid json' }));

        expect(res.status).toBe(422);
        const body = await bodyOf<{ code: string; error: string }>(res);
        expect(body.code).toBe('validation_failed');
        expect(body.error).toBe('Request body must be valid JSON');
        expect(getDeviceIdForSession).not.toHaveBeenCalled();
    });

    it('DELETE with no body succeeds — regression guard for dropping def-level request.body', async () => {
        vi.mocked(getDeviceIdForSession).mockResolvedValue('device-123');
        vi.mocked(deletePushTokenForDevice).mockResolvedValue(1);
        vi.mocked(getDb).mockReturnValue(makeFakeSql([{ environment: 'sandbox' }]));

        const { DELETE } = mount(def, CTX);
        const event = makeEvent({ username: 'alice', method: 'DELETE', rawBody: null });
        expect(event.request.headers.get('content-type')).toBeNull();

        const res = await DELETE!(event);

        expect(res.status).toBe(200);
        const body = await bodyOf<{
            registered: boolean;
            environment: string;
            deviceId: string;
        }>(res);
        expect(body.registered).toBe(false);
        expect(body.environment).toBe('sandbox');
        expect(body.deviceId).toBe('device-123');
        // Deletes by uuid, same translation as PUT.
        expect(deletePushTokenForDevice).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            DEVICE_UUID,
        );
    });

    it('PUT returns 409 when the session resolves to a device with no user_devices row', async () => {
        vi.mocked(getDeviceIdForSession).mockResolvedValue('device-123');
        vi.mocked(getUserDeviceByDeviceId).mockResolvedValue(null);

        const { PUT } = mount(def, CTX);
        const res = await PUT!(
            makeEvent({ username: 'alice', rawBody: JSON.stringify(VALID_BODY) }),
        );

        expect(res.status).toBe(409);
        // Never attempt the write with an unresolvable device.
        expect(upsertPushToken).not.toHaveBeenCalled();
    });

    it('happy-path PUT returns 200 with the registered shape and redacts the token in the log', async () => {
        vi.mocked(getDeviceIdForSession).mockResolvedValue('device-123');
        vi.mocked(upsertPushToken).mockResolvedValue({} as never);

        const { PUT } = mount(def, CTX);
        const res = await PUT!(
            makeEvent({ username: 'alice', rawBody: JSON.stringify(VALID_BODY) }),
        );

        expect(res.status).toBe(200);
        const body = await bodyOf<{
            deviceSessionId: string;
            deviceId: string;
            environment: string;
            registered: boolean;
        }>(res);
        expect(body).toEqual({
            deviceSessionId: DEVICE_SESSION_ID,
            deviceId: 'device-123',
            environment: 'production',
            registered: true,
        });
        // The WRITE gets the uuid; the RESPONSE keeps the client-generated id
        // the rest of the device routes speak. `user_push_tokens.device_id` is
        // `uuid REFERENCES user_devices(id)`, while `getDeviceIdForSession`
        // returns `oauth_refresh_tokens.device_id` — client TEXT. Passing the
        // text straight through blew up on the uuid cast for every real caller;
        // the def test never caught it because both were mocked strings.
        expect(upsertPushToken).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ token: VALID_BODY.token, deviceId: DEVICE_UUID }),
        );
        expect(getUserDeviceByDeviceId).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'device-123',
        );

        // Redaction: the full 64-char token must never reach the log line.
        expect(mockLoggerInfo).toHaveBeenCalledWith(
            'Push token registered',
            expect.objectContaining({ token: `${VALID_BODY.token.substring(0, 8)}...` }),
        );
        const loggedFields = mockLoggerInfo.mock.calls.at(-1)?.[1] as { token: string };
        expect(loggedFields.token).not.toBe(VALID_BODY.token);
    });
});

// ── auth-gate behaviour (Gap 3) ───────────────────────────────────────────────
//
// The "is gated behind FEATURE_DEVICE_AUTH then user auth" test above only
// asserts the def's declared `auth` shape — it would pass unchanged against a
// mount()/enforce() that silently stopped honouring that shape. These drive
// the real handler through mount() so the feature-off 404 and unauthenticated
// 401 paths are actually exercised, mirroring devices.defs.test.ts's
// "returns 404 when FEATURE_DEVICE_AUTH is false" / "returns 401 when
// unauthenticated" pair for the sibling devices def.

describe('push-token def — auth gate behaviour', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(getDb).mockReturnValue(makeFakeSql());
    });

    it('returns 404 when FEATURE_DEVICE_AUTH is false', async () => {
        const { config } = await import('$lib/server/config.js');
        const originalValue = (config as unknown as Record<string, unknown>).FEATURE_DEVICE_AUTH;
        (config as unknown as Record<string, unknown>).FEATURE_DEVICE_AUTH = false;

        try {
            const { PUT } = mount(def, CTX);
            const res = await PUT!(
                makeEvent({ username: 'alice', rawBody: JSON.stringify(VALID_BODY) }),
            );
            expect(res.status).toBe(404);
            const body = await bodyOf<{ code: string }>(res);
            expect(body.code).toBe('not_found');
            // The feature gate short-circuits before user auth or the handler —
            // no device lookup, no write.
            expect(getDeviceIdForSession).not.toHaveBeenCalled();
            expect(upsertPushToken).not.toHaveBeenCalled();
        } finally {
            (config as unknown as Record<string, unknown>).FEATURE_DEVICE_AUTH = originalValue;
        }
    });

    it('returns 401 when unauthenticated', async () => {
        const { PUT } = mount(def, CTX);
        const res = await PUT!(makeEvent({ rawBody: JSON.stringify(VALID_BODY) }));
        expect(res.status).toBe(401);
        expect(getDeviceIdForSession).not.toHaveBeenCalled();
        expect(upsertPushToken).not.toHaveBeenCalled();
    });
});
