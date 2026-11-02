// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for the bug this route previously had: it read
 * docs/api/openapi.yaml (the "Combined" spec, which its own info.description
 * says is "Do not use for documentation") instead of docs/api/api-v1.yaml
 * (the deliberately public-safe spec — admin routes are kept out of it by
 * the openapi-admin-internal-visibility lint rule). Loading the combined
 * file leaked every internal/admin endpoint shape to an unauthenticated
 * caller under the former access policy. The hooks gate now requires a
 * signed-in session, while this route still serves only the public-safe spec.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { parse } from 'yaml';
import * as oauth from '$lib/server/oauth';

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

vi.mock('$lib/server/oauth', () => ({
    isDeviceAuthEnabled: vi.fn(),
}));

async function getYaml(): Promise<string> {
    vi.resetModules();
    vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(true);
    const { GET } = await import('./+server.js');
    const res = await GET({
        url: new URL('http://localhost/api-docs?format=yaml'),
    } as never);
    return res.text();
}

describe('GET /api-docs', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ['md', 'text/markdown; charset=utf-8'],
        ['markdown', 'text/markdown; charset=utf-8'],
        ['yaml', 'text/yaml; charset=utf-8'],
        ['json', 'application/json; charset=utf-8'],
        ['', 'text/html; charset=utf-8'],
    ])('privately caches the %s documentation format for one hour', async (format, contentType) => {
        vi.resetModules();
        vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(true);
        const { GET } = await import('./+server.js');
        const url = new URL('http://localhost/api-docs');
        if (format) url.searchParams.set('format', format);
        const res = await GET({ url } as never);

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
        expect(res.headers.get('Content-Type')).toBe(contentType);
        const body = await res.text();
        if (format === 'md' || format === 'markdown') {
            expect(body).toBe(fs.readFileSync('docs/api/API.md', 'utf-8'));
        } else if (format === 'yaml') {
            expect(body).toBe(fs.readFileSync('docs/api/api-v1.yaml', 'utf-8'));
        } else if (format === 'json') {
            expect(JSON.parse(body)).toEqual(
                parse(fs.readFileSync('docs/api/api-v1.yaml', 'utf-8'), { maxAliasCount: -1 }),
            );
        } else {
            expect(body).toContain('<!DOCTYPE html>');
            expect(body).toContain("url: '/api-docs?format=json'");
        }
    });

    it.each(['yaml', 'json'])(
        'returns a valid private %s fallback explaining artifact unavailability',
        async (format) => {
            vi.resetModules();
            vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(true);
            const { GET } = await import('./+server.js');
            const actualFs = await vi.importActual<typeof import('fs')>('fs');
            const readSpec = vi.mocked(fs.readFileSync).mockImplementation((...args) => {
                if (String(args[0]).endsWith('docs/api/api-v1.yaml')) {
                    throw new Error('Spec artifact unavailable');
                }
                return actualFs.readFileSync(...args);
            });
            const res = await GET({
                url: new URL(`http://localhost/api-docs?format=${format}`),
            } as never);
            const body = await res.text();
            const spec = format === 'json' ? JSON.parse(body) : parse(body);

            expect(readSpec).toHaveBeenCalledWith(
                expect.stringContaining('docs/api/api-v1.yaml'),
                'utf-8',
            );
            expect(res.status).toBe(200);
            expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
            expect(res.headers.get('Content-Type')).toBe(
                format === 'json' ? 'application/json; charset=utf-8' : 'text/yaml; charset=utf-8',
            );
            expect(spec).toEqual({
                openapi: '3.1.0',
                info: {
                    title: 'Lumastra API',
                    version: '1.0.0',
                    description:
                        'The OpenAPI spec artifact is unavailable. Contact the instance administrator.',
                },
                paths: {},
            });
        },
    );

    it.each(['md', 'markdown'])(
        'privately serves the %s fallback when Markdown is unavailable',
        async (format) => {
            vi.resetModules();
            vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(true);
            const { GET } = await import('./+server.js');
            const actualFs = await vi.importActual<typeof import('fs')>('fs');
            vi.mocked(fs.readFileSync).mockImplementation((...args) => {
                if (String(args[0]).endsWith('docs/api/API.md')) {
                    throw new Error('Markdown artifact unavailable');
                }
                return actualFs.readFileSync(...args);
            });
            const res = await GET({
                url: new URL(`http://localhost/api-docs?format=${format}`),
            } as never);
            expect(res.status).toBe(200);
            expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
            expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
            expect(await res.text()).toBe(
                '# API Documentation\n\nSee /api-docs?format=yaml for the OpenAPI spec.',
            );
        },
    );

    it('returns 404 when device auth is disabled', async () => {
        vi.resetModules();
        vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(false);
        const { GET } = await import('./+server.js');
        const res = await GET({ url: new URL('http://localhost/api-docs') } as never);
        expect(res.status).toBe(404);
    });

    it('serves a spec that excludes internal/admin-only routes', async () => {
        const yaml = await getYaml();
        // A known admin-only endpoint that must NEVER be publicly documented.
        expect(yaml).not.toContain('/api/v1/admin/playback-incidents');
    });

    it('serves a spec that DOES include the real public surface', async () => {
        const yaml = await getYaml();
        // A known public endpoint that must be present — guards against the
        // fix over-correcting into an empty/wrong file.
        expect(yaml).toContain('/api/v1/play-sessions');
    });

    it('the JSON format is derived from the same public spec', async () => {
        vi.resetModules();
        vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(true);
        const { GET } = await import('./+server.js');
        const res = await GET({
            url: new URL('http://localhost/api-docs?format=json'),
        } as never);
        const body = (await res.json()) as { paths?: Record<string, unknown> };
        expect(body.paths).toBeDefined();
        expect(Object.keys(body.paths!)).not.toContain('/api/v1/admin/playback-incidents');
        expect(Object.keys(body.paths!)).toContain('/api/v1/play-sessions');
        // Superseded before 0.1 and moved to the internal spec (package 7).
        expect(Object.keys(body.paths!)).not.toContain('/api/v1/playback/incidents');
    });

    // The app-wide CSP allows only same-origin scripts/styles, so the Swagger UI page went
    // blank ("SwaggerUIBundle is not defined") until it sent its own policy.
    it('the Swagger UI page allows its pinned, integrity-checked CDN assets in its own CSP', async () => {
        vi.resetModules();
        vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(true);
        const { GET } = await import('./+server.js');
        const res = await GET({ url: new URL('http://localhost/api-docs') } as never);
        const html = await res.text();
        const csp = res.headers.get('Content-Security-Policy') ?? '';

        const external = [
            ...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https:[^"]+)"[^>]*>/g),
        ];
        expect(external).toHaveLength(2);
        for (const [tag, src] of external) {
            expect(src).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\//);
            expect(tag).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
            expect(tag).toContain('crossorigin="anonymous"');
        }
        expect(csp).toMatch(/script-src [^;]*https:\/\/unpkg\.com/);
        expect(csp).toMatch(/style-src [^;]*https:\/\/unpkg\.com/);
        expect(csp).toContain("object-src 'none'");
    });
});

it('serves the same contract guide at /llms.txt', async () => {
    vi.resetModules();
    vi.mocked(oauth.isDeviceAuthEnabled).mockReturnValue(true);
    const { GET } = await import('../llms.txt/+server.js');
    const response = await GET({} as never);
    expect(response.status).toBe(200);
    const guide = fs.readFileSync('docs/api/API.md', 'utf-8');
    expect(await response.text()).toBe(guide);
    expect(guide).toContain('Online audiobook starts read AudiobookShelf (ABS) progress');
    expect(guide).not.toContain('?mode=explore');
});
