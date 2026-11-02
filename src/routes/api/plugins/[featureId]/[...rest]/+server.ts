// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type { RequestHandler as SvelteKitRequestHandler, RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildRequestPluginContext } from '$lib/server/tasks/plugin-context.js';
import { dispatchFeatureRequest } from '$lib/server/plugins/runtime/feature-dispatch.js';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import type { PluginUser } from '@sapd/lumastra-plugin-sdk';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

// C26 (2026-09-16 fix plan): this route had no rate limiter at all — a
// plugin feature handler's own limiter (e.g. shoutbox's 6/min post cap)
// bounds only the DB cost of a request that has ALREADY been parsed, not the
// request rate itself. Keyed on the strict (non-spoofable) IP + username so
// an unauthenticated flood (username 'anonymous') is still bounded, not just
// an authenticated one.
const RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW_SEC = 60;

function toPluginUser(locals: App.Locals): PluginUser | null {
    const user = locals.user;
    if (!user) return null;
    return {
        // The stable key every plugin should store per user. `username` below
        // is the mutable display handle and must not be used as a data key —
        // see PluginUser's doc comment for why.
        userId: String(user.userId),
        username: user.username,
        groups: user.userGroups ?? [],
        isAdmin: localsIsAdmin(locals),
    };
}

const dispatch: SvelteKitRequestHandler = async ({ params, request, locals }) =>
    dispatchFeatureRequest(
        {
            featureId: params.featureId ?? '',
            rest: params.rest ?? '',
            method: request.method,
            request,
            user: toPluginUser(locals),
        },
        {
            getFeature: (id) => taskRegistry.getAllFeatures().find((f) => f.id === id),
            buildCtx: (featureId, user) =>
                buildRequestPluginContext(featureId, {
                    user,
                    userLiveTv: locals.user?.hasLiveTvPermission,
                    userRaw: locals.user,
                }),
        },
    );

// C26: one shared budget across every method — a plugin feature route is not
// a "read vs write" split the way the DisplayPreferences compat routes are,
// so all five verbs draw from the same per-IP+user bucket.
const handle: RequestHandler = withValkeyRateLimit(
    RATE_LIMIT,
    RATE_LIMIT_WINDOW_SEC,
    (event: RequestEvent) =>
        `plugin-feature:${getClientIpStrict(event)}:${event.locals.user?.username ?? 'anonymous'}`,
    { strict: true },
)(dispatch);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
