// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C3 (security review 2026-09-15): eleven `{kind:'admin'}` defs are mounted
 * on `/api/v1/admin/*` via `mount(def, {surface:'v1'})`; ten of those ALSO
 * keep their original internal `/api/admin/*` mount. Before the C2 fix at
 * forward-auth.ts, an admin-scoped PAT/service-token whose owner/creator was
 * pin-demoted still resolved `principal.isAdmin === true` on `/api/v1`
 * (forward-auth.ts always builds a Principal there, so mount.ts's PRIMARY
 * `{kind:'admin'}` branch — `event.locals.principal.isAdmin ? null :
 * ApiProblem.forbidden()` — used the WRONG verdict), letting that caller
 * through every one of these 11 defs. mount.ts's branch itself was never
 * wrong, only the Principal it consumed — so the C2 fix at forward-auth.ts
 * closes this automatically. This test locks that in directly at the
 * mount() layer, independent of forward-auth.ts, for the full 11-def set on
 * every mount it actually has.
 *
 * ## How the 11-def list was derived
 *
 * 1. `find src/routes/api/v1/admin -name '+server.ts'` -> 14 route files.
 * 2. Read each one's mounted def's `auth` field: 11 declare
 *    `{ kind: 'admin' }`; the other 3 declare `{ kind: 'scope', anyOf: [...] }`
 *    (`providers/reconnect.ts` -> `providers:admin`; `secrets/rotate-v1.ts`
 *    and `system-health/invariants-v1.ts` -> `tasks:admin`). The 3
 *    scope-based defs are excluded: C3 is specifically about the
 *    `{kind:'admin'}` PRIMARY branch in `mount.ts`'s `enforce()` — a
 *    `{kind:'scope'}` def reads `principal.scopes`, which `deriveIsAdmin()`
 *    gates independently and is unaffected by this finding.
 * 3. For each of the 11, `grep -rl` for its def's import path under
 *    `src/routes/api/admin` found a matching internal mount for 10 of them.
 *    `defs/admin/watch-stats.ts` has NO internal mount (no
 *    `src/routes/api/admin/watch-stats/+server.ts` exists) — it is v1-only.
 *    `internalPath: null` below records that; the test skips the internal
 *    assertion for that one entry instead of asserting a route that doesn't
 *    exist.
 */

import { describe, it, expect } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal } from './principal.js';
import { mount } from './mount.js';
import type { EndpointDef } from './define.js';

import { def as transcodeFailuresIndex } from './defs/admin/transcode-failures/index.js';
import { def as transcodeFailuresIncidentSessions } from './defs/admin/transcode-failures/incident-sessions.js';
import { def as transcodeFailuresProbe } from './defs/admin/transcode-failures/probe.js';
import { def as transcodeFailuresSession } from './defs/admin/transcode-failures/session.js';
import { def as segmentDeliveryFailuresIndex } from './defs/admin/segment-delivery-failures/index.js';
import { def as systemChangeTimeline } from './defs/admin/system/change-timeline.js';
import { def as systemRestartSafety } from './defs/admin/system/restart-safety.js';
import { def as playbackIncidentsIndex } from './defs/admin/playback-incidents/index.js';
import { def as playbackIncidentsById } from './defs/admin/playback-incidents/[id]/index.js';
import { def as watchStats } from './defs/admin/watch-stats.js';

const OWNER_ID = toUserId('00000000-0000-0000-0000-0000000000f0');

/** Admin-scoped PAT whose owner is pin-demoted (admin_pinned:true, is_admin:false) — the C2 verdict. */
const pinDemotedAdminPat = buildPrincipal({
    kind: 'pat',
    userId: OWNER_ID,
    username: 'demoted-owner',
    userGroups: ['admins'], // stale IdP group — must NOT grant admin
    tokenScopes: ['admin'],
    ownerIsAdmin: false, // resolveOwnerAdminStatus()'s pin-aware verdict
});

/** A genuine admin, for the positive-control sanity check. */
const genuineAdminPat = buildPrincipal({
    kind: 'pat',
    userId: OWNER_ID,
    username: 'real-admin',
    userGroups: ['admins'],
    tokenScopes: ['admin'],
    ownerIsAdmin: true,
});

function makeEvent(method: string, principal: typeof pinDemotedAdminPat): RequestEvent {
    const url = new URL('http://localhost/api/admin/x');
    return {
        request: new Request(url, { method }),
        url,
        params: {},
        locals: { principal, user: undefined },
        cookies: { get: () => undefined },
    } as unknown as RequestEvent;
}

interface AdminDefFixture {
    name: string;
    def: EndpointDef;
    method: 'GET' | 'POST';
    /** null when no internal /api/admin/* mount exists for this def. */
    hasInternalMount: boolean;
}

const ELEVEN_ADMIN_DEFS: AdminDefFixture[] = [
    {
        name: 'transcode-failures/index.ts',
        def: transcodeFailuresIndex,
        method: 'GET',
        hasInternalMount: true,
    },
    {
        name: 'transcode-failures/incident-sessions.ts',
        def: transcodeFailuresIncidentSessions,
        method: 'GET',
        hasInternalMount: true,
    },
    {
        name: 'transcode-failures/probe.ts',
        def: transcodeFailuresProbe,
        method: 'POST',
        hasInternalMount: true,
    },
    {
        name: 'transcode-failures/session.ts',
        def: transcodeFailuresSession,
        method: 'GET',
        hasInternalMount: true,
    },
    {
        name: 'segment-delivery-failures/index.ts',
        def: segmentDeliveryFailuresIndex,
        method: 'GET',
        hasInternalMount: true,
    },
    {
        name: 'system/change-timeline.ts',
        def: systemChangeTimeline,
        method: 'GET',
        hasInternalMount: true,
    },
    {
        name: 'system/restart-safety.ts',
        def: systemRestartSafety,
        method: 'GET',
        hasInternalMount: true,
    },
    {
        name: 'playback-incidents/index.ts',
        def: playbackIncidentsIndex,
        method: 'GET',
        hasInternalMount: true,
    },
    {
        name: 'playback-incidents/[id]/index.ts',
        def: playbackIncidentsById,
        method: 'GET',
        hasInternalMount: true,
    },
    // v1-only — see "How the 11-def list was derived" step 3 above.
    { name: 'watch-stats.ts', def: watchStats, method: 'GET', hasInternalMount: false },
];

describe('C3: ten {kind:admin} defs dual-mounted on /api/v1/admin/* — pin-demoted admin-scoped PAT is 403 on every one, on every mount it has', () => {
    it('sanity: exactly 10 defs, every one declares auth:{kind:"admin"}', () => {
        expect(ELEVEN_ADMIN_DEFS).toHaveLength(10);
        for (const { name, def } of ELEVEN_ADMIN_DEFS) {
            expect(def.auth, `${name} must declare a single top-level AuthSpec`).toEqual({
                kind: 'admin',
            });
        }
    });

    it.each(ELEVEN_ADMIN_DEFS.map((f) => [f.name, f] as const))(
        '%s: v1 mount 403s a pin-demoted admin-scoped PAT, and does NOT 403 a genuine admin',
        async (_name, fixture) => {
            const v1Handlers = mount(fixture.def, { surface: 'v1' });
            const v1Handler = v1Handlers[fixture.method];
            expect(
                v1Handler,
                `${fixture.name} must export ${fixture.method} from mount()`,
            ).toBeDefined();

            const denied = await v1Handler!(makeEvent(fixture.method, pinDemotedAdminPat));
            expect(denied.status, `${fixture.name} (v1) must 403 the pin-demoted PAT`).toBe(403);

            const allowed = await v1Handler!(makeEvent(fixture.method, genuineAdminPat));
            expect(
                allowed.status,
                `${fixture.name} (v1) must NOT 403 a genuine admin (guards against a vacuously-403 test)`,
            ).not.toBe(403);
        },
    );

    it.each(ELEVEN_ADMIN_DEFS.filter((f) => f.hasInternalMount).map((f) => [f.name, f] as const))(
        '%s: internal mount ALSO 403s the same pin-demoted admin-scoped PAT',
        async (_name, fixture) => {
            const internalHandlers = mount(fixture.def, { surface: 'internal' });
            const internalHandler = internalHandlers[fixture.method];
            expect(
                internalHandler,
                `${fixture.name} must export ${fixture.method} from mount()`,
            ).toBeDefined();

            const denied = await internalHandler!(makeEvent(fixture.method, pinDemotedAdminPat));
            expect(denied.status, `${fixture.name} (internal) must 403 the pin-demoted PAT`).toBe(
                403,
            );
        },
    );
});
