// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-hardcoded-api-path rule.
 *
 * The rule is path-scoped to src/lib/server/api/defs/**. We exercise:
 *  - correct surface-derived usage (valid)
 *  - the two real defect shapes: '/api/v1/series/' + id, and getCatalog*Url (invalid)
 *  - non-def files, which must stay silent even with /api literals
 *  - a def's own *.test.ts, which is EXEMPT (tests assert on concrete paths)
 *  - strings that merely contain "api" but are not /api paths (valid)
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-hardcoded-api-path');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const DEF_PATH = '/repo/src/lib/server/api/defs/catalog/series-id.ts';
const CLIENT_PATH = '/repo/src/lib/components/player/telemetry.ts';
const SERVER_LOAD_PATH = '/repo/src/routes/admin/users/+page.server.ts';
const DEF_NESTED_PATH = '/repo/src/lib/server/api/defs/music/albums/[id].ts';
const DEF_TEST_PATH = '/repo/src/lib/server/api/defs/browse/az.test.ts';
const DEF_INTEGRATION_TEST_PATH = '/repo/src/lib/server/api/defs/browse/az.integration.test.ts';
const ROUTE_PATH = '/repo/src/routes/api/v1/series/[id]/+server.ts';
const SERVICE_PATH = '/repo/src/lib/server/services/media-aggregation.service.ts';
const CLIENT_UTIL_PATH = '/repo/src/lib/utils/image-utils.ts';

ruleTester.run('no-hardcoded-api-path', rule, {
    valid: [
        // ── correct usage: everything derived from ctx.surface ──
        {
            code: `
                import { apiUrl, entityImageUrl, buildImageRefs } from '$lib/shared/api-urls';
                const href = apiUrl(ctx.surface, \`/series/\${id}\`);
                const poster = entityImageUrl(row.id, 'poster', ctx.surface, { size: 'card' });
                const images = buildImageRefs(row.id, ctx.surface);
            `,
            filename: DEF_PATH,
        },
        {
            // Template built on an already-derived prefix — no /api chunk anywhere.
            code: `
                import { apiBase } from '$lib/shared/api-urls';
                const prefix = apiBase(ctx.surface);
                const href = \`\${prefix}/media/\${id}/images/poster?size=thumb\`;
            `,
            filename: DEF_PATH,
        },

        // ── strings that merely contain "api" are NOT paths ──
        {
            code: `
                const a = 'openapi';
                const b = 'api_key';
                const c = 'The api returned an error';
                const d = '/api-docs';
                const e = 'https://api.themoviedb.org/3/movie';
                const f = \`rapid/api/thing\`;
            `,
            filename: DEF_PATH,
        },
        {
            // Non-string literals and sql templates must not trip the chunk check.
            code: `
                const n = 42;
                const q = sql\`SELECT id FROM media_items WHERE has_files = true\`;
            `,
            filename: DEF_PATH,
        },

        // ── rule is path-scoped: non-def files keep their literals ──
        {
            code: `const href = '/api/v1/series/' + id;`,
            filename: ROUTE_PATH,
        },
        {
            code: `const href = \`/api/image/catalog/\${id}/poster\`;`,
            filename: SERVICE_PATH,
        },
        {
            code: `
                export function getCatalogPosterUrl(id) {
                    return \`/api/image/catalog/\${id}/poster\`;
                }
            `,
            filename: CLIENT_UTIL_PATH,
        },

        // ── a def's own tests are EXEMPT: asserting the concrete emitted path is
        //    exactly what proves the surface derivation works ──
        {
            code: `
                import { getCatalogPosterUrl } from '$lib/utils/image-utils';
                expect(body.images.poster.href).toBe(\`/api/v1/media/\${id}/images/poster\`);
                expect(internal.images.poster.href).toBe('/api/media/x/images/poster');
            `,
            filename: DEF_TEST_PATH,
        },
        {
            code: `expect(href).toBe('/api/v1/series/abc');`,
            filename: DEF_INTEGRATION_TEST_PATH,
        },

        // ── import specifiers are never treated as path chunks ──
        {
            code: `import { apiUrl } from '$lib/shared/api-urls';`,
            filename: DEF_PATH,
        },

        // ── eslint-disable escape hatch.
        // RuleTester runs the rule under the synthetic id `rule-to-test/...`,
        // so we use that prefix here. Real callsites use the real plugin name.
        {
            code: `
                // eslint-disable-next-line rule-to-test/no-hardcoded-api-path
                const documented = '/api/v1/media/{id}/images/{role}';
            `,
            filename: DEF_PATH,
        },

        // The DOCUMENTED escape-hatch shape (docs/dev/eslint-exceptions.md): the reason
        // comment sits ABOVE the directive. Pinned as a test because the inverse order
        // silently fails — the directive would attach to the comment, leaving the
        // violation reported AND adding an unused-directive warning that --max-warnings=0
        // turns into a build failure (and that `eslint --fix` "fixes" by deleting it).
        {
            code: `
                // Documenting the canonical route shape, not emitting a link.
                // eslint-disable-next-line rule-to-test/no-hardcoded-api-path
                const documented = '/api/v1/media/{id}/images/{role}';
            `,
            filename: DEF_PATH,
        },

        // The sanctioned fix for items that have no internal UUID: the entity image
        // route accepts a composite provider key, so these are surface-aware too.
        // Nothing here starts with /api, so the rule must stay quiet.
        {
            code: `
                import { entityImageUrl } from '$lib/shared/api-urls';
                const href = entityImageUrl(\`tmdb:\${id}:episode\`, 'still', ctx.surface, {
                    size: 'thumb',
                    path: stillPath,
                });
            `,
            filename: DEF_PATH,
        },

        // ── app-wide: a plain client fetch IS covered by the interceptor, so the
        // rule must stay quiet on it — flagging these would flood ~400 call sites.
        {
            code: `const res = await fetch('/api/admin/users');`,
            filename: CLIENT_PATH,
        },
        {
            code: `const es = new EventSource(apiUrl('internal', '/events/user'));`,
            filename: CLIENT_PATH,
        },
        // Outside defs, a bare literal that never reaches a sink is fine.
        {
            code: `const DOC = '/api/v1/media/{id}/images/{role}';`,
            filename: CLIENT_PATH,
        },
    ],

    invalid: [
        // ── app-wide: sinks the fetch interceptor cannot rewrite ──
        {
            code: `const es = new EventSource('/api/events/user');`,
            filename: CLIENT_PATH,
            errors: [{ messageId: 'nonFetchSink' }],
        },
        {
            code: `navigator.sendBeacon('/api/playback/telemetry', blob);`,
            filename: CLIENT_PATH,
            errors: [{ messageId: 'nonFetchSink' }],
        },
        {
            code: 'const es = new EventSource(`/api/runs/${id}/logs`);',
            filename: CLIENT_PATH,
            errors: [{ messageId: 'nonFetchSink' }],
        },
        {
            code: `img.src = '/api/image/catalog/abc/poster';`,
            filename: CLIENT_PATH,
            errors: [{ messageId: 'nonFetchSink' }],
        },
        {
            code: `const res = await fetch('/api/admin/users');`,
            filename: SERVER_LOAD_PATH,
            errors: [{ messageId: 'nonFetchSink' }],
        },

        // ── defect class 2: hardcoded v1 link concatenated with an id ──
        {
            code: `const href = '/api/v1/series/' + id;`,
            filename: DEF_PATH,
            errors: [{ messageId: 'hardcodedPath' }],
        },
        {
            code: `const href = \`/api/v1/series/\${id}/seasons\`;`,
            filename: DEF_PATH,
            errors: [{ messageId: 'hardcodedPath' }],
        },
        {
            // The internal form is equally wrong — it is wrong on the v1 mount.
            code: `const href = \`/api/media/\${id}/images/poster\`;`,
            filename: DEF_NESTED_PATH,
            errors: [{ messageId: 'hardcodedPath' }],
        },
        {
            // /api chunk sits in the SECOND quasi, after an interpolation.
            code: `const href = \`\${base}/api/v1/media/\${id}/images/poster\`;`,
            filename: DEF_PATH,
            errors: [{ messageId: 'hardcodedPath' }],
        },
        {
            // The bare imageBase string literal that started the whole drift.
            code: `const IMAGE_BASE = '/api/v1/media';`,
            filename: DEF_PATH,
            errors: [{ messageId: 'hardcodedPath' }],
        },
        {
            code: `const p = '/api';`,
            filename: DEF_PATH,
            errors: [{ messageId: 'hardcodedPath' }],
        },
        {
            // Query-string boundary still counts as a path prefix.
            code: `const p = '/api?debug=1';`,
            filename: DEF_PATH,
            errors: [{ messageId: 'hardcodedPath' }],
        },
        {
            // One report per offending chunk.
            code: `
                const a = '/api/tasks';
                const b = \`/api/v1/tasks\`;
            `,
            filename: DEF_PATH,
            errors: [{ messageId: 'hardcodedPath' }, { messageId: 'hardcodedPath' }],
        },

        // ── defect class 1: catalog image helpers (no /api/v1 route exists) ──
        {
            code: `import { getCatalogPosterUrl } from '$lib/utils/image-utils';`,
            filename: DEF_PATH,
            errors: [{ messageId: 'catalogUrlHelper', data: { name: 'getCatalogPosterUrl' } }],
        },
        {
            code: `import { getCatalogImageUrl, getCatalogBackdropUrl } from '$lib/utils/image-utils';`,
            filename: DEF_PATH,
            errors: [
                { messageId: 'catalogUrlHelper', data: { name: 'getCatalogImageUrl' } },
                { messageId: 'catalogUrlHelper', data: { name: 'getCatalogBackdropUrl' } },
            ],
        },
        {
            // Renamed on import — the imported name is what matters.
            code: `import { getCatalogPosterUrl as posterUrl } from '$lib/utils/image-utils';`,
            filename: DEF_NESTED_PATH,
            errors: [{ messageId: 'catalogUrlHelper', data: { name: 'getCatalogPosterUrl' } }],
        },
        {
            // srcset variants hardcode the same catalog route.
            code: `import { getCatalogPosterSrcSet } from '$lib/utils/image-utils';`,
            filename: DEF_PATH,
            errors: [{ messageId: 'catalogUrlHelper', data: { name: 'getCatalogPosterSrcSet' } }],
        },

        // ── defect class 3: the retired imageBase mapper ──
        {
            code: `import { toEntityImageBase } from '$lib/server/utils/api-transforms';`,
            filename: DEF_PATH,
            errors: [{ messageId: 'entityImageBaseMapper' }],
        },
        {
            code: `import type { X } from './x'; import { toEntityImageBase, other } from '$lib/server/utils/api-transforms';`,
            filename: DEF_NESTED_PATH,
            errors: [{ messageId: 'entityImageBaseMapper' }],
        },

        // ── mixed: helper import AND a literal in the same def ──
        {
            code: `
                import { getCatalogPosterUrl } from '$lib/utils/image-utils';
                const href = \`/api/v1/series/\${id}\`;
            `,
            filename: DEF_PATH,
            errors: [
                { messageId: 'catalogUrlHelper', data: { name: 'getCatalogPosterUrl' } },
                { messageId: 'hardcodedPath' },
            ],
        },
    ],
});

console.log('  ✅ no-hardcoded-api-path: all tests passed');
