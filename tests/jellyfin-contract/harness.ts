// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Contract-suite harness: mint a real /j session (Valkey), build a RequestEvent the
 * real route handler (incl. withJellyfinAuth) accepts, and check the JSON it returns
 * against the jellyfin-sdk-kotlin contract digest. Every checked body is written to
 * out/<name>.json with an out/manifest.json entry for the JVM decode step.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { expect } from 'vitest';
import { createSession } from '$lib/server/proprietary/jellyfin-compat/auth';
import {
    validateAgainstSchema,
    validateJellyfinResponse,
    type Violation,
} from '$lib/server/proprietary/jellyfin-compat/contract/validate';
import { getContractDigest } from '$lib/server/proprietary/jellyfin-compat/contract/digest';

const OUT = new URL('./out/', import.meta.url);
export const DEFAULT_CLIENT = 'Jellyfin Android TV';
export const DEFAULT_VERSION = '0.19.10';

/**
 * Any route's exported handler. Each route types its own RequestEvent (params,
 * route id), so a single concrete event type would reject all but one of them.
 */
export type RouteHandler = (e: never) => Promise<Response> | Response;

export async function mintJfSession(
    _sql: postgres.Sql,
    opts: {
        userId: string;
        username: string;
        client?: string;
        version?: string;
        deviceId?: string;
    },
): Promise<string> {
    const token = await createSession({
        userId: opts.userId,
        username: opts.username,
        isAdmin: false,
        groups: [],
        displayName: opts.username,
        deviceId: opts.deviceId ?? 'contract-device',
        deviceName: 'Contract TV',
        clientName: opts.client ?? DEFAULT_CLIENT,
        clientVersion: opts.version ?? DEFAULT_VERSION,
        createdAt: new Date().toISOString(),
    } as Parameters<typeof createSession>[0]);
    if (!token) throw new Error('createSession returned null (Valkey reachable?)');
    return token;
}

export function jfEvent(opts: {
    method: 'GET' | 'POST';
    path: string;
    /** Omit for unauthenticated routes (AuthenticateByName): no Token= is sent. */
    token?: string;
    params: Record<string, string>;
    body?: unknown;
    client?: string;
    version?: string;
    deviceId?: string;
}): RequestEvent {
    const url = new URL(`http://localhost${opts.path}`);
    const parts = [
        `MediaBrowser Client="${opts.client ?? DEFAULT_CLIENT}"`,
        'Device="Contract TV"',
        `DeviceId="${opts.deviceId ?? 'contract-device'}"`,
        `Version="${opts.version ?? DEFAULT_VERSION}"`,
    ];
    if (opts.token) parts.push(`Token="${opts.token}"`);
    const auth = parts.join(', ');
    const request = new Request(url, {
        method: opts.method,
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: auth,
            'x-emby-authorization': auth,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return {
        request,
        url,
        params: opts.params,
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => {},
            delete: () => {},
            serialize: () => '',
        },
        fetch: globalThis.fetch,
        getClientAddress: () => '127.0.0.1',
        setHeaders: () => {},
        platform: undefined,
        route: { id: null },
        isDataRequest: false,
        isSubRequest: false,
    } as unknown as RequestEvent;
}

/** Write one checked body to out/<name>.json and record it in out/manifest.json. */
export function writeOutput(name: string, kotlinClass: string, body: unknown): void {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(body));
    const manifestUrl = new URL('manifest.json', OUT);
    const manifest: { file: string; kotlinClass: string }[] = existsSync(manifestUrl)
        ? JSON.parse(readFileSync(manifestUrl, 'utf8'))
        : [];
    writeFileSync(
        manifestUrl,
        JSON.stringify(
            [
                ...manifest.filter((m) => m.file !== `${name}.json`),
                { file: `${name}.json`, kotlinClass },
            ],
            null,
            2,
        ),
    );
}

/**
 * Call a real route handler, assert 2xx and zero SDK-breaking (`error`) violations,
 * then write the body to out/.
 *
 * `legacySchema` is only for routes that no SDK spec of record (1.6.3+) lists any
 * more but older clients still call (e.g. `/Users/{userId}/Items`, dropped in
 * Jellyfin 10.9). Such a route cannot match the route map, so its body is checked
 * against the schema the old route returned. Every other route must match.
 */
export async function callAndCheck(
    name: string,
    kotlinClass: string,
    handler: RouteHandler,
    event: RequestEvent,
    opts: { legacySchema?: string } = {},
): Promise<unknown> {
    const res = await (handler as (e: RequestEvent) => Promise<Response> | Response)(event);
    expect(res.status, `${name}: HTTP ${res.status} ${await res.clone().text()}`).toBeLessThan(300);
    const body = await res.json();
    let violations: Violation[];
    if (opts.legacySchema) {
        violations = validateAgainstSchema(getContractDigest(), opts.legacySchema, body, {
            clientName: DEFAULT_CLIENT,
        });
    } else {
        const r = validateJellyfinResponse(event.request.method, event.url.pathname, body, {
            clientName: DEFAULT_CLIENT,
        });
        expect(r.unmatched, `${name}: ${event.url.pathname} is not in the contract route map`).toBe(
            false,
        );
        violations = r.violations;
    }
    const errors = violations
        .filter((v) => v.severity === 'error')
        .map(
            (v) =>
                `${v.pointer} ${v.schema}.${v.property} ${v.kind} [${v.versions.join(',')}]${v.detail ? ` ${v.detail}` : ''}`,
        );
    expect(errors, `${name}: SDK-breaking fields`).toEqual([]);
    for (const w of violations.filter((v) => v.severity === 'warn')) {
        console.warn(`[${name}] warn ${w.pointer} ${w.kind} ${w.detail ?? ''}`);
    }
    writeOutput(name, kotlinClass, body);
    return body;
}
