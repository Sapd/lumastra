// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the response-contract audit gate in mount().
 *
 * The bug this guards against shipped for real: `GET /api/v1/search` emitted
 * `album` + `duration` (from SearchService.mapMusicRow) while the response
 * schema declared neither. Because the generated spec carries
 * `additionalProperties: false`, strict decoders (tvOS/Swift) failed the WHOLE
 * response — every search with a music hit came back empty — while the server
 * itself reported nothing wrong.
 *
 * The audit is a THREE-MODE gate keyed on NODE_ENV:
 *   - production  → strips undeclared 2xx fields, counts drift, rate-limits strip warnings.
 *   - development → logs and counts drift, strips undeclared 2xx fields.
 *   - test        → gate: THROWS ResponseContractViolation so drift fails a test.
 *
 * These tests assert the gate, conformance behavior, and telemetry in all three modes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';

const mockError = vi.fn();
const mockWarn = vi.fn();
const mockCount = vi.fn();
vi.mock('./conformance-counter.js', () => ({
    countConformance: (...args: unknown[]) => mockCount(...args),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: (...a: unknown[]) => mockWarn(...a),
            error: (...a: unknown[]) => mockError(...a),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

const { mount, ResponseContractViolation } = await import('./mount.js');
const { defineEndpoint } = await import('./define.js');

/**
 * A synthetic RequestEvent.
 *
 * `routeId` is the SvelteKit route id (`/api/v1/me/music/pinned-genres/[genre]`),
 * which mount() converts to the OpenAPI `{param}` form to resolve a
 * `docsByPath` def. SvelteKit populates `event.route.id` at routing time
 * (respond.js sets `event.route = { id }` before `render_endpoint` runs), so it
 * is always present in the real handler path. Defaulting it to `null` here
 * keeps the `docs`-based tests exercising the no-route-id path too.
 */
function makeEvent(routeId: string | null = null, pathname = '/api/v1/thing'): RequestEvent {
    return {
        request: new Request(`http://localhost${pathname}`, { method: 'GET' }),
        locals: {},
        url: new URL(`http://localhost${pathname}`),
        params: {},
        route: { id: routeId },
    } as unknown as RequestEvent;
}

/** A def whose declared item shape can be made to omit fields the "service" emits. */
function makeDef(responseBody: unknown, schema: z.ZodType, status = 200) {
    return defineEndpoint({
        auth: { kind: 'public' },
        docs: {
            GET: {
                tags: ['Test'],
                summary: 'test',
                responses: { [status]: { schema, description: 'ok' } },
            },
        },
        handlers: {
            GET: () =>
                new Response(JSON.stringify(responseBody), {
                    status,
                    headers: { 'content-type': 'application/json' },
                }),
        },
    });
}

// NODE_ENV is read directly by the audit at call time. Save/restore around each
// mode block so a thrown assertion never leaks a mode into another test.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('mount() response-contract audit', () => {
    beforeEach(() => {
        mockCount.mockClear();
        mockError.mockClear();
        mockWarn.mockClear();
    });
    afterEach(() => {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    });

    // -----------------------------------------------------------------------
    // test mode — the GATE: drift THROWS so a test fails.
    // -----------------------------------------------------------------------
    describe('test mode (NODE_ENV=test) — gate', () => {
        beforeEach(() => {
            process.env.NODE_ENV = 'test';
        });

        it('throws on undeclared fields — the exact tvOS-breaking shape from /api/v1/search', async () => {
            const schema = z.object({
                items: z.array(z.object({ id: z.string(), title: z.string() })),
            });
            const def = makeDef(
                {
                    items: [
                        { id: 't1', title: 'Stutter', album: 'Songs About Jane', duration: 189 },
                    ],
                },
                schema,
            );
            const handlers = mount(def, { surface: 'v1' } as never);
            const err = await Promise.resolve(handlers.GET!(makeEvent())).then(
                () => null,
                (e: unknown) => e,
            );
            // Must name BOTH undeclared fields — reporting only the first would
            // let the second ship after a "fix". Paths are dotted.
            expect(err).toBeInstanceOf(ResponseContractViolation);
            expect(
                (err as InstanceType<typeof ResponseContractViolation>).detail.undeclaredFields,
            ).toEqual(expect.arrayContaining(['items[].album', 'items[].duration']));
        });

        it('throws on drift nested inside arrays, not just the top level', async () => {
            const schema = z.object({
                page: z.object({ limit: z.number() }),
                items: z.array(z.object({ id: z.string() })),
            });
            const def = makeDef(
                { page: { limit: 10 }, items: [{ id: 'a' }, { id: 'b', sneaky: true }] },
                schema,
            );
            const handlers = mount(def, { surface: 'v1' } as never);
            await expect(handlers.GET!(makeEvent())).rejects.toMatchObject({
                detail: { undeclaredFields: expect.arrayContaining(['items[].sneaky']) },
            });
        });

        it('throws on a required-field / type mismatch too', async () => {
            const schema = z.object({ duration: z.number() });
            const def = makeDef({ duration: '189' }, schema);
            const handlers = mount(def, { surface: 'v1' } as never);
            await expect(handlers.GET!(makeEvent())).rejects.toBeInstanceOf(
                ResponseContractViolation,
            );
        });

        it('stays silent (no throw) when the response matches its schema', async () => {
            const schema = z.object({ id: z.string(), title: z.string() });
            const def = makeDef({ id: 'x', title: 'ok' }, schema);
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            expect(res.status).toBe(200);
            expect(mockError).not.toHaveBeenCalled();
            expect(mockWarn).not.toHaveBeenCalled();
        });

        it('ignores non-JSON responses instead of throwing', async () => {
            const def = defineEndpoint({
                auth: { kind: 'public' },
                docs: {
                    GET: {
                        tags: ['Test'],
                        summary: 'test',
                        responses: {
                            200: { schema: z.object({ id: z.string() }), description: 'ok' },
                        },
                    },
                },
                handlers: {
                    GET: () =>
                        new Response('not json at all', {
                            status: 200,
                            headers: { 'content-type': 'text/plain' },
                        }),
                },
            });
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            await expect(res.text()).resolves.toBe('not json at all');
        });

        it('ignores a status with no declared schema (e.g. problem+json errors)', async () => {
            // Schema declared for 200 only; handler returns 404 — no audit, no throw.
            const def = makeDef({ ok: true }, z.object({ ok: z.boolean() }), 200);
            const errDef = defineEndpoint({
                auth: def.auth,
                docs: def.docs,
                handlers: {
                    GET: () =>
                        new Response(JSON.stringify({ type: 'not_found', extra: 'x' }), {
                            status: 404,
                            headers: { 'content-type': 'application/json' },
                        }),
                },
            });
            const handlers = mount(errDef, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            expect(res.status).toBe(404);
        });

        // ---------------------------------------------------------------------
        // `docsByPath` defs — FORMERLY A GAP.
        //
        // `inspectResponse` used to read ONLY `def.docs?.[method]?.responses?.
        // [status]`, never `def.docsByPath`. A def that declares its response
        // schemas exclusively via `docsByPath` (because it is mounted at several
        // paths with different shapes) therefore got NO runtime response-contract
        // protection at all: no throw in test, no dev drift warning, no prod
        // stripping. Two defs were in that state — `defs/user/music/pinned-genres.ts`
        // and `defs/catalog/series/seasons.ts`.
        //
        // mount() now derives the OpenAPI `{param}` path from `event.route.id`
        // and resolves docs the way the generator does
        // (generate-public.ts:~1019): `docsByPath` wins when it claims the path,
        // `docs` is the fallback. The tests below pin BOTH halves of that.
        // ---------------------------------------------------------------------
        it('fires the gate for a docsByPath-only def (was the KNOWN GAP)', async () => {
            const schema = z.object({ id: z.string() });
            const def = defineEndpoint({
                auth: { kind: 'public' },
                docsByPath: () => ({
                    GET: {
                        tags: ['Test'],
                        summary: 'test',
                        responses: { 200: { schema, description: 'ok' } },
                    },
                }),
                handlers: {
                    GET: () =>
                        new Response(JSON.stringify({ id: 'x', undeclared: 'should be caught' }), {
                            status: 200,
                            headers: { 'content-type': 'application/json' },
                        }),
                },
            });
            const handlers = mount(def, { surface: 'v1' } as never);
            await expect(handlers.GET!(makeEvent('/api/v1/thing'))).rejects.toMatchObject({
                detail: { undeclaredFields: ['undeclared'] },
            });
        });

        it('passes the {param}-form OpenAPI path to docsByPath, not the SvelteKit route id', async () => {
            const seen: string[] = [];
            const def = defineEndpoint({
                auth: { kind: 'public' },
                docsByPath: (p: string) => {
                    seen.push(p);
                    return undefined;
                },
                handlers: {
                    GET: () =>
                        new Response(JSON.stringify({ id: 'x' }), {
                            status: 200,
                            headers: { 'content-type': 'application/json' },
                        }),
                },
            });
            const handlers = mount(def, { surface: 'v1' } as never);
            await handlers.GET!(
                makeEvent('/api/v1/series/[id]/seasons/[n]', '/api/v1/series/abc/seasons/2'),
            );
            expect(seen).toEqual(['/api/v1/series/{id}/seasons/{n}']);
        });

        it('resolves DIFFERENT schemas per mount — the whole reason docsByPath exists', async () => {
            // Collection mount declares `items`; the {param} node declares a bare
            // object. Serving the node shape from the node path must pass, and the
            // SAME body must be judged against the COLLECTION schema on the
            // collection path (where it is drift).
            const def = defineEndpoint({
                auth: { kind: 'public' },
                docsByPath: (p: string) =>
                    p.endsWith('/{n}')
                        ? {
                              GET: {
                                  tags: ['Test'],
                                  summary: 'node',
                                  responses: {
                                      200: {
                                          schema: z.object({ seasonNumber: z.number() }),
                                          description: 'ok',
                                      },
                                  },
                              },
                          }
                        : {
                              GET: {
                                  tags: ['Test'],
                                  summary: 'collection',
                                  responses: {
                                      200: {
                                          schema: z.object({ items: z.array(z.unknown()) }),
                                          description: 'ok',
                                      },
                                  },
                              },
                          },
                handlers: {
                    GET: () =>
                        new Response(JSON.stringify({ seasonNumber: 2 }), {
                            status: 200,
                            headers: { 'content-type': 'application/json' },
                        }),
                },
            });
            const handlers = mount(def, { surface: 'v1' } as never);

            // Node path → node schema → conforms.
            const ok = await handlers.GET!(makeEvent('/api/v1/series/[id]/seasons/[n]'));
            expect(ok.status).toBe(200);

            // Collection path → collection schema → drift (missing `items`,
            // undeclared `seasonNumber`).
            await expect(
                handlers.GET!(makeEvent('/api/v1/series/[id]/seasons')),
            ).rejects.toBeInstanceOf(ResponseContractViolation);
        });

        it('falls back to `docs` when docsByPath declines the path (generator precedence)', async () => {
            const def = defineEndpoint({
                auth: { kind: 'public' },
                docs: {
                    GET: {
                        tags: ['Test'],
                        summary: 'fallback',
                        responses: {
                            200: { schema: z.object({ id: z.string() }), description: 'ok' },
                        },
                    },
                },
                docsByPath: () => undefined,
                handlers: {
                    GET: () =>
                        new Response(JSON.stringify({ id: 'x', undeclared: 1 }), {
                            status: 200,
                            headers: { 'content-type': 'application/json' },
                        }),
                },
            });
            const handlers = mount(def, { surface: 'v1' } as never);
            await expect(handlers.GET!(makeEvent('/api/v1/thing'))).rejects.toMatchObject({
                detail: { undeclaredFields: ['undeclared'] },
            });
        });

        it('does not crash when event.route.id is absent — falls back to `docs`', async () => {
            // Synthetic events (and any non-routed invocation) may have no route
            // id. That must degrade to the old `docs`-only behaviour, never throw.
            const def = defineEndpoint({
                auth: { kind: 'public' },
                docsByPath: () => ({
                    GET: {
                        tags: ['Test'],
                        summary: 'test',
                        responses: {
                            200: { schema: z.object({ id: z.string() }), description: 'ok' },
                        },
                    },
                }),
                handlers: {
                    GET: () =>
                        new Response(JSON.stringify({ id: 'x', undeclared: 1 }), {
                            status: 200,
                            headers: { 'content-type': 'application/json' },
                        }),
                },
            });
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent(null));
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ id: 'x', undeclared: 1 });
        });

        it('never lets a throwing docsByPath break the request', async () => {
            const def = defineEndpoint({
                auth: { kind: 'public' },
                docsByPath: () => {
                    throw new Error('boom');
                },
                handlers: {
                    GET: () =>
                        new Response(JSON.stringify({ id: 'x' }), {
                            status: 200,
                            headers: { 'content-type': 'application/json' },
                        }),
                },
            });
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent('/api/v1/thing'));
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual({ id: 'x' });
        });
    });

    describe('conformance telemetry', () => {
        it.each(['development', 'production'])(
            'counts documented error mismatches in %s',
            async (mode) => {
                process.env.NODE_ENV = mode;
                const handlers = mount(makeDef({ id: 123 }, z.object({ id: z.string() }), 422), {
                    surface: 'internal',
                });
                const response = await handlers.GET!(
                    makeEvent('/api/items/[id]', '/api/items/private-id'),
                );
                expect(response.status).toBe(422);
                expect(await response.json()).toEqual({ id: 123 });
                expect(mockCount).toHaveBeenCalledWith('GET', '/api/items/[id]', 'mismatch', [
                    'id:invalid_type',
                ]);
            },
        );

        it('counts dev strips but excludes successful error bodies and conforming responses', async () => {
            process.env.NODE_ENV = 'development';
            for (const status of [200, 422]) {
                await mount(
                    makeDef({ id: 'a', extra: true }, z.object({ id: z.string() }), status),
                    { surface: 'internal' },
                ).GET!(makeEvent('/api/items/[id]'));
            }
            await mount(makeDef({ id: 'a' }, z.object({ id: z.string() })), { surface: 'internal' })
                .GET!(makeEvent('/api/items/[id]'));
            expect(mockCount.mock.calls).toEqual([
                ['GET', '/api/items/[id]', 'stripped', ['extra']],
            ]);
        });

        it('does not count in test mode, including when the gate throws', async () => {
            process.env.NODE_ENV = 'test';
            await expect(
                mount(makeDef({ extra: 1 }, z.object({ id: z.string() })), { surface: 'internal' })
                    .GET!(makeEvent('/api/items/[id]')),
            ).rejects.toBeInstanceOf(ResponseContractViolation);
            expect(mockCount).not.toHaveBeenCalled();
        });

        it('warns at most once per route per hour while counting every strip, without logging the body', async () => {
            process.env.NODE_ENV = 'production';
            const clock = vi.spyOn(Date, 'now');
            try {
                clock.mockReturnValue(10_000);
                const handlers = mount(
                    makeDef(
                        { id: 'secret-body', extra: 'secret-extra' },
                        z.object({ id: z.string() }),
                    ),
                    { surface: 'internal' },
                );
                const event = makeEvent('/api/hourly/[id]', '/api/hourly/private-id');
                await handlers.GET!(event);
                await handlers.GET!(event);
                expect(mockWarn).toHaveBeenCalledTimes(1);
                expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('secret');
                expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('private-id');
                clock.mockReturnValue(3_610_000);
                await handlers.GET!(event);
                expect(mockWarn).toHaveBeenCalledTimes(2);
                expect(mockCount).toHaveBeenCalledTimes(3);
            } finally {
                clock.mockRestore();
            }
        });
    });

    // -----------------------------------------------------------------------
    // development mode — OBSERVE drift (log) AND CONFORM (strip 2xx bodies).
    // -----------------------------------------------------------------------
    describe('development mode (NODE_ENV=development) — observe + conform', () => {
        beforeEach(() => {
            process.env.NODE_ENV = 'development';
        });

        it('logs an error for undeclared fields but does not throw', async () => {
            const schema = z.object({
                items: z.array(z.object({ id: z.string(), title: z.string() })),
            });
            const def = makeDef(
                { items: [{ id: 't1', title: 'Stutter', album: 'X', duration: 189 }] },
                schema,
            );
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            expect(res.status).toBe(200);
            expect(mockError).toHaveBeenCalledTimes(1);
            // Logger.error is (message, error?, data?) — NOT (message, data?) like
            // Logger.warn. This assertion previously read the detail from arg 1,
            // which matched the buggy call and so let the bug ship: in prod the
            // payload landed in the Error slot and logged as `undefined`, leaving
            // the first real drift hit with no route or field name in it. Assert
            // arg 2 so the correct signature is pinned.
            const [message, errArg, detail] = mockError.mock.calls[0] as [
                string,
                undefined,
                Record<string, unknown>,
            ];
            expect(message).toContain('RESPONSE CONTRACT DRIFT');
            expect(errArg).toBeUndefined();
            expect(detail.undeclaredFields).toEqual(
                expect.arrayContaining(['items[].album', 'items[].duration']),
            );
        });

        it('STRIPS undeclared keys from the wire (conformance)', async () => {
            const schema = z.object({ id: z.string() });
            const def = makeDef({ id: 'x', undeclared: 'stripped in dev' }, schema);
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            // The undeclared key is dropped so the wire matches the published spec.
            await expect(res.json()).resolves.toEqual({ id: 'x' });
            expect(res.status).toBe(200);
        });

        it('reports a type mismatch as a warning and passes the ORIGINAL through', async () => {
            const schema = z.object({ duration: z.number() });
            const def = makeDef({ duration: '189' }, schema);
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            expect(mockError).not.toHaveBeenCalled();
            expect(mockWarn).toHaveBeenCalledTimes(1);
            // Hard failure (wrong type) can't be stripped — original passes through.
            await expect(res.json()).resolves.toEqual({ duration: '189' });
        });

        it('stays silent when the response matches its schema', async () => {
            const schema = z.object({ id: z.string(), title: z.string() });
            const def = makeDef({ id: 'x', title: 'ok' }, schema);
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            expect(mockError).not.toHaveBeenCalled();
            expect(mockWarn).not.toHaveBeenCalled();
            await expect(res.json()).resolves.toEqual({ id: 'x', title: 'ok' });
        });
    });

    // -----------------------------------------------------------------------
    // production mode — CONFORM (strip + warn); pass-through + log on hard fail.
    // -----------------------------------------------------------------------
    describe('production mode (NODE_ENV=production) — conform', () => {
        beforeEach(() => {
            process.env.NODE_ENV = 'production';
        });

        it('strips undeclared keys and warns so the wire matches the spec', async () => {
            const schema = z.object({ id: z.string() });
            const def = makeDef({ id: 'x', undeclared: 'stripped in prod' }, schema);
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent('/api/prod-strip/[id]'));
            await expect(res.json()).resolves.toEqual({ id: 'x' });
            expect(res.status).toBe(200);
            expect(mockError).not.toHaveBeenCalled();
            expect(mockWarn).toHaveBeenCalledTimes(1);
            expect(mockCount).toHaveBeenCalledWith('GET', '/api/prod-strip/[id]', 'stripped', [
                'undeclared',
            ]);
        });

        it('on a HARD failure (missing required) logs and passes the ORIGINAL through — never 500', async () => {
            // `name` is required but never emitted — stripping is impossible.
            const schema = z.object({ id: z.string(), name: z.string() });
            const body = { id: 'x' };
            const def = makeDef(body, schema);
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            expect(res.status).toBe(200);
            await expect(res.json()).resolves.toEqual(body);
            expect(mockError).toHaveBeenCalledTimes(1);
            const [message] = mockError.mock.calls[0] as [string, Record<string, unknown>];
            expect(message).toContain('RESPONSE CONFORMANCE');
        });

        // A docsByPath def is mounted on BOTH surfaces from the SAME def — the
        // real shape of defs/user/music/pinned-genres.ts, whose predicate branches on
        // `/v1/` to hand the public mount a narrower doc set than the internal
        // one. Stripping must fire on each, driven by that mount's own schema.
        it.each([
            ['v1', '/api/v1/me/music/pinned-genres', '/api/v1/me/music/pinned-genres'],
            ['internal', '/api/me/music/pinned-genres', '/api/me/music/pinned-genres'],
        ])(
            'strips undeclared keys on the %s mount of a docsByPath def',
            async (_surface, routeId, pathname) => {
                const seen: string[] = [];
                const def = defineEndpoint({
                    auth: { kind: 'public' },
                    docsByPath: (p: string) => {
                        seen.push(p);
                        if (!p.endsWith('/pinned-genres')) return undefined;
                        return {
                            GET: {
                                tags: ['Test'],
                                summary: 'pinned genres',
                                responses: {
                                    200: {
                                        schema: z.object({
                                            pinnedGenres: z.array(
                                                z.object({ id: z.number(), genre: z.string() }),
                                            ),
                                        }),
                                        description: 'ok',
                                    },
                                },
                            },
                        };
                    },
                    handlers: {
                        GET: () =>
                            new Response(
                                JSON.stringify({
                                    pinnedGenres: [{ id: 1, genre: 'Rock', leaked: 'strip me' }],
                                }),
                                { status: 200, headers: { 'content-type': 'application/json' } },
                            ),
                    },
                });
                const handlers = mount(def, { surface: 'v1' } as never);
                const res = await handlers.GET!(makeEvent(routeId, pathname));
                // The predicate saw the {param}-form path for THIS mount — proving the
                // /api/v1 vs internal /api prefix reaches docsByPath intact.
                expect(seen).toEqual([pathname]);
                await expect(res.json()).resolves.toEqual({
                    pinnedGenres: [{ id: 1, genre: 'Rock' }],
                });
            },
        );

        it('does not touch a non-2xx body (only 2xx are conformed)', async () => {
            const schema = z.object({ id: z.string() });
            const def = makeDef({ id: 'x', undeclared: 'kept on errors' }, schema, 422);
            const handlers = mount(def, { surface: 'v1' } as never);
            const res = await handlers.GET!(makeEvent());
            expect(res.status).toBe(422);
            await expect(res.json()).resolves.toEqual({ id: 'x', undeclared: 'kept on errors' });
        });
    });
});
