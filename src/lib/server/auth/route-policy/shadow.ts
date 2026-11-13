// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shadow mode for the route policy table (design spec 2026-10-07 §6, step 1).
 *
 * Wraps `mainHandle`, works out what the table WOULD decide for each request,
 * compares that with what today's layered gates actually answered, and logs
 * every disagreement once per key. It never changes a response: everything
 * after the inner handle runs inside try/catch, a throw only bumps an error
 * counter, and no request or response body is read.
 *
 * Off unless `ROUTE_POLICY_MODE=shadow` (env only; preprod and prod set it).
 */

import { isRedirect, type Handle, type RequestEvent } from '@sveltejs/kit';
import { Counter } from 'prom-client';
import { base } from '$app/paths';
import { Logger } from '$lib/server/utils/logger.js';
import { tasksRegistry } from '$lib/server/tasks/metrics.js';
import {
    isPrivateRouteId,
    normalizeRouteId,
    policyForMethod,
    type RoutePolicy,
} from './policy.js';
import { routePolicyTable } from './table.js';
import { localsIsAdmin } from '../locals-admin.js';

const log = Logger.for('RoutePolicyShadow');

/**
 * Counters are created on first use, so with shadow mode off `/metrics` is
 * unchanged; `getSingleMetric` keeps a module re-import (HMR, tests) from
 * registering a name twice.
 */
function counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
    const existing = tasksRegistry.getSingleMetric(name);
    if (existing) return existing as Counter<string>;
    return new Counter({ name, help, labelNames, registers: [tasksRegistry] });
}
const shadowTotal = (): Counter<string> =>
    counter(
        'lumastra_route_policy_shadow_total',
        'Route policy shadow comparisons by mismatch class (ok = agreement)',
        ['class', 'policy'],
    );
const shadowDropped = (): Counter<string> =>
    counter(
        'lumastra_route_policy_shadow_dropped_total',
        'Shadow mismatch log lines not written because the per-process key set was full',
    );
const shadowErrors = (): Counter<string> =>
    counter(
        'lumastra_route_policy_shadow_errors_total',
        'Exceptions inside route policy shadow evaluation (never affect the response)',
    );

/** Which of today's hooks gates answered before `resolve()`. */
export type OldGate = 'resolveAuth' | 'v1-backstop' | 'admin-gate';

/** Identity as the gates saw it — handlers may change `locals` during resolve. */
interface IdentitySnapshot {
    identified: boolean;
    userIsAdmin: boolean;
    principalIsAdmin: boolean | null;
    principalKind: string | null;
    who: string;
}

interface ShadowState {
    gate?: OldGate;
    identity?: IdentitySnapshot;
    /** Status before the bypass-path anti-fingerprint collapse turned it into a 404. */
    originalStatus?: number;
}

const states = new WeakMap<object, ShadowState>();

function state(event: RequestEvent): ShadowState {
    let s = states.get(event);
    if (!s) {
        s = {};
        states.set(event, s);
    }
    return s;
}

/**
 * Called by `mainHandle` just before each of today's gates runs (a gate may
 * answer by throwing a redirect), so the shadow can tell a gate's answer from a
 * handler's. A no-op when shadow mode is off.
 */
export function markOldGate(event: RequestEvent, gate: OldGate): void {
    if (shadowEnabled()) state(event).gate = gate;
}

/**
 * The gate let the request through: whatever answers next is not that gate.
 * The first call (right after resolveAuth) also records the identity the gates
 * judge, before any handler can touch `locals`.
 */
export function clearOldGate(event: RequestEvent): void {
    if (!shadowEnabled()) return;
    const s = state(event);
    s.gate = undefined;
    if (!s.identity) {
        try {
            s.identity = snapshotIdentity(event);
        } catch {
            shadowErrors().inc();
        }
    }
}

/** The anti-fingerprint guard collapsed a handler's HTML error into a 404. */
export function noteCollapsedStatus(event: RequestEvent, status: number): void {
    if (shadowEnabled()) state(event).originalStatus = status;
}

function modeValue(): string {
    return (process.env.ROUTE_POLICY_MODE ?? '').trim().toLowerCase();
}

export function shadowEnabled(): boolean {
    return modeValue() === 'shadow';
}

export interface ShadowDeps {
    /** hooks.server.ts's /api/v1 backstop predicate, unchanged. */
    isApiV1RequestAuthorized(event: RequestEvent): boolean;
    /** features.deviceAuth — the /api/admin Bearer deferral is gated on it. */
    deviceAuthEnabled(): boolean;
}

const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const MAX_KEYS = 10_000;
const seen = new Set<string>();

/** Test hook: forget which mismatch keys were already logged. */
export function resetShadowForTests(): void {
    seen.clear();
}

type Decision = 'allow' | 'auth-required' | 'forbidden' | 'admin-redirect';

interface Outcome {
    status: number;
    location: string | null;
    where: OldGate | 'handler';
    /** An Authorization header, `api_key` or `stream_token` came with the request. */
    credentialPresented?: boolean;
}

function stripBase(pathname: string): string {
    if (!base || !(pathname === base || pathname.startsWith(`${base}/`))) return pathname;
    return pathname.slice(base.length) || '/';
}

function locationClass(location: string | null): 'login' | 'setup' | 'home' | 'other' | null {
    if (!location) return null;
    let path: string;
    try {
        path = stripBase(new URL(location, 'http://x').pathname);
    } catch {
        return 'other';
    }
    if (path === '/login' || path.startsWith('/login/')) return 'login';
    if (path === '/setup' || path.startsWith('/setup/')) return 'setup';
    if (path === '/') return 'home';
    return 'other';
}

/** What the old layers did, reduced to a comparable verdict. */
function oldVerdict(o: Outcome): Decision | 'allow-404' | 'kill-switch' {
    const loc = locationClass(o.location);
    if (o.where === 'resolveAuth' && [400, 404, 503].includes(o.status)) return 'kill-switch';
    // resolveAuth answers only to stop a request; its "Authentication not
    // configured" help page is a 2xx HTML page that still means "sign in".
    if (o.where === 'resolveAuth' && o.status < 300) return 'auth-required';
    if (o.status === 401 || loc === 'login' || loc === 'setup') return 'auth-required';
    if (o.status === 403) return 'forbidden';
    if (o.where === 'admin-gate' && o.status >= 300 && o.status < 400) return 'admin-redirect';
    if (o.status === 404) return 'allow-404';
    return 'allow';
}

function isReadMethod(method: string): boolean {
    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function hasBearerHeader(event: RequestEvent): boolean {
    return /^bearer[ \t]+\S/i.test(event.request.headers.get('authorization') ?? '');
}

function underPrefix(normalizedId: string, prefix: string): boolean {
    return normalizedId === prefix || normalizedId.startsWith(`${prefix}/`);
}

/**
 * The table's decision with step-1 semantics (design §1.4): each surface keeps
 * today's exact predicate; `admin-scoped` rows outside /api/admin and the
 * /api/v1 rows are evaluated at the surface's floor, since no hooks gate exists
 * for them yet.
 */
function evaluate(
    policy: RoutePolicy,
    normalizedId: string,
    event: RequestEvent,
    who: IdentitySnapshot,
    deps: ShadowDeps,
): Decision {
    const kind = policy.split(':')[0];
    if (kind === 'public' || kind === 'token-surface') return 'allow';

    const identified = who.identified;
    const isAdmin = who.userIsAdmin;

    if (underPrefix(normalizedId, '/api/v1')) {
        // The backstop predicate; identity as the gate saw it, then the
        // credential-in-URL / signed-path clauses (headers and query are stable).
        return identified || deps.isApiV1RequestAuthorized(event) ? 'allow' : 'auth-required';
    }
    if (!identified) {
        // /api/admin passes an unidentified Bearer request to the route today.
        if (kind === 'admin-scoped' && underPrefix(normalizedId, '/api/admin')) {
            return deps.deviceAuthEnabled() && hasBearerHeader(event) ? 'allow' : 'auth-required';
        }
        return 'auth-required';
    }
    if (kind === 'admin' && underPrefix(normalizedId, '/admin')) {
        if (isAdmin) return 'allow';
        return isReadMethod(event.request.method) ? 'admin-redirect' : 'forbidden';
    }
    if (kind === 'admin-scoped' && underPrefix(normalizedId, '/api/admin')) {
        if (isAdmin || (deps.deviceAuthEnabled() && hasBearerHeader(event))) return 'allow';
        return 'forbidden';
    }
    return 'allow';
}

function snapshotIdentity(event: RequestEvent): IdentitySnapshot {
    const principal = event.locals.principal;
    const user = event.locals.user as { ownerIsAdmin?: boolean } | undefined;
    return {
        identified: Boolean(principal || user),
        // eslint-disable-next-line callback-safety/no-locals-user-is-admin -- shadow diagnostics record the owner flag next to the principal's verdict
        userIsAdmin: Boolean(user?.ownerIsAdmin),
        principalIsAdmin: principal ? Boolean(principal.isAdmin) : null,
        principalKind: principal?.kind ?? null,
        who: principalClass(event),
    };
}

function principalClass(event: RequestEvent): string {
    const principal = event.locals.principal;
    const user = event.locals.user as { ownerIsAdmin?: boolean } | undefined;
    const kind = principal?.kind ?? (user ? (event.locals.authMethod ?? 'user') : 'anon');
    const admin = localsIsAdmin(event.locals) ? 'admin' : 'nonadmin';
    const url = event.url;
    const carrier = event.request.headers.has('authorization')
        ? 'header'
        : url.searchParams.has('api_key') ||
            url.searchParams.has('stream_token') ||
            url.searchParams.has('sig')
          ? 'query'
          : event.cookies.get('lumastra_session')
            ? 'cookie'
            : 'none';
    const scopes = principal?.scopes ?? [];
    const scope = scopes.includes('admin')
        ? 'admin'
        : scopes.includes('write')
          ? 'write'
          : scopes.includes('read')
            ? 'read'
            : 'none';
    return `${kind}|${admin}|${carrier}|${scope}`;
}

function classify(
    policy: RoutePolicy,
    newDecision: Decision,
    old: ReturnType<typeof oldVerdict>,
    o: Outcome,
): string {
    if (old === 'kill-switch') return 'ok';
    if (newDecision === 'allow') {
        if (old === 'allow' || old === 'allow-404') return 'ok';
        if (o.where === 'resolveAuth') {
            // A presented credential that identity resolution refused (bad token,
            // read-only scope on a write, rate limit) is not a policy question.
            if (o.credentialPresented && [401, 403, 429].includes(o.status)) return 'ok';
            return 'M6';
        }
        if (o.where !== 'handler') return 'M2';
        // A public or token-surface route that refuses a caller is doing its own
        // authentication — the reason the row exists, not a disagreement.
        if (policy === 'public' || policy.startsWith('token-surface:')) return 'ok';
        if (old === 'auth-required') return 'M3';
        return 'M4';
    }
    if (old === 'allow-404') return 'M8';
    if (old === 'allow') return 'M1';
    return old === newDecision ? 'ok' : 'M7';
}

function record(
    event: RequestEvent,
    who: string,
    routeId: string,
    policy: RoutePolicy | 'no-rule',
    rulePattern: string | null,
    cls: string,
    detail: Record<string, unknown>,
): void {
    shadowTotal().inc({ class: cls, policy: policy.split(':')[0] });
    if (cls === 'ok' || cls === 'M8') return;
    const method = KNOWN_METHODS.has(event.request.method) ? event.request.method : '_other';
    const key = `${routeId}|${method}|${who}|${cls}`;
    if (seen.has(key)) return;
    if (seen.size >= MAX_KEYS) {
        shadowDropped().inc();
        return;
    }
    seen.add(key);
    log.warn('route_policy_shadow_mismatch', {
        class: cls,
        routeId,
        method,
        principal: who,
        policy,
        rule: rulePattern,
        ...detail,
    });
}

function compare(event: RequestEvent, o: Outcome, deps: ShadowDeps): void {
    const routeId = event.route.id;
    if (!routeId || isPrivateRouteId(routeId)) return;
    const s = states.get(event);
    // Identity as the gates judged it; when resolveAuth answered, nothing was set.
    const who = s?.identity ?? snapshotIdentity(event);
    const normalizedId = normalizeRouteId(routeId);
    const match = routePolicyTable.match(routeId);
    if (!match) {
        record(event, who.who, routeId, 'no-rule', null, 'M0', {
            oldStatus: o.status,
            oldWhere: o.where,
        });
        return;
    }
    const policy = policyForMethod(match.rule, event.request.method);
    const newDecision = evaluate(policy, normalizedId, event, who, deps);
    const old = oldVerdict(o);
    const cls = classify(policy, newDecision, old, o);
    record(event, who.who, routeId, policy, match.rule.pattern, cls, {
        oldStatus: o.status,
        oldWhere: o.where,
        oldLocation: locationClass(o.location),
        newDecision,
    });

    if (
        who.principalIsAdmin !== null &&
        who.identified &&
        who.principalIsAdmin !== who.userIsAdmin
    ) {
        const cookie = who.principalKind === 'session' || who.principalKind === 'forward_auth';
        // A scoped token owned by an admin is deliberately non-admin. User and
        // public policies do not consult that flag, so this is no disagreement.
        // Keep session/forward-auth inconsistencies and admin-policy diagnostics.
        if (!cookie && (policy === 'user' || policy === 'public')) return;
        record(event, who.who, routeId, policy, match.rule.pattern, cookie ? 'M5-cookie' : 'M5', {
            principalIsAdmin: who.principalIsAdmin,
            userIsAdmin: who.userIsAdmin,
        });
    }
}

/** Wrap `mainHandle`. With shadow mode off the wrapper only calls `inner`. */
export function withRoutePolicyShadow(inner: Handle, deps: ShadowDeps): Handle {
    const mode = modeValue();
    if (mode === 'shadow') log.info('Route policy table: shadow mode on (log-only)');
    else if (mode && mode !== 'off') {
        log.warn(`Unknown ROUTE_POLICY_MODE "${mode}" — expected "shadow" or "off"; running off`);
    }
    return async (input) => {
        if (!shadowEnabled()) return inner(input);
        const { event } = input;
        let response: Response;
        try {
            response = await inner(input);
        } catch (err) {
            if (isRedirect(err)) {
                safeCompare(event, deps, { status: err.status, location: err.location }, null);
            }
            throw err;
        }
        safeCompare(
            event,
            deps,
            { status: response.status, location: response.headers.get('location') },
            response,
        );
        return response;
    };
}

function safeCompare(
    event: RequestEvent,
    deps: ShadowDeps,
    answer: { status: number; location: string | null },
    response: Response | null,
): void {
    try {
        const s = states.get(event);
        const where = s?.gate ?? 'handler';
        // The CORS preflight is answered before any gate runs; it is not a decision.
        if (
            !s &&
            event.request.method === 'OPTIONS' &&
            answer.status === 204 &&
            response?.headers.has('access-control-allow-methods')
        ) {
            return;
        }
        const credentialPresented =
            event.request.headers.has('authorization') ||
            event.url.searchParams.has('api_key') ||
            event.url.searchParams.has('stream_token');
        compare(
            event,
            { ...answer, status: s?.originalStatus ?? answer.status, where, credentialPresented },
            deps,
        );
    } catch {
        shadowErrors().inc();
    }
}
