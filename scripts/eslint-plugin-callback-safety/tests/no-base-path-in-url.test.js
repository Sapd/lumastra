// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-base-path-in-url rule.
 *
 * We exercise:
 *  - the real defect shape: `${config.BASE_PATH}/api/...` and `/v1/...` (invalid)
 *  - the legitimate filesystem usage that must stay silent (valid)
 *  - provenance tracking: only a `config` bound via an import from a `.../config`
 *    module counts, matching/aliasing/relative sources all work, and an unrelated
 *    local named `config` must not be flagged
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-base-path-in-url');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const SERVICE_PATH = '/repo/src/lib/server/services/watch-together.service.ts';
const ROUTE_PATH = '/repo/src/routes/api/v1/watch-together/parties/+server.ts';

ruleTester.run('no-base-path-in-url', rule, {
    valid: [
        // ── the legitimate filesystem usage: nothing starts with /api or /v1 ──
        {
            code: `
                import { config } from '$lib/server/config';
                const baseDir = config.BASE_PATH || '/data';
                const metadataDir = \`\${config.BASE_PATH}/metadata/music\`;
            `,
            filename: SERVICE_PATH,
        },
        {
            code: `
                import { config } from '../config';
                const dir = path.join(config.BASE_PATH || '/tmp', 'image-sync');
            `,
            filename: SERVICE_PATH,
        },

        // ── an unrelated local named `config`, never imported from a config module ──
        {
            code: `
                const config = { BASE_PATH: 'whatever' };
                const href = \`\${config.BASE_PATH}/api/v1/x\`;
            `,
            filename: SERVICE_PATH,
        },
        {
            code: `
                import { config } from '$lib/branding-config';
                const href = \`\${config.BASE_PATH}/api/v1/x\`;
            `,
            filename: SERVICE_PATH,
        },

        // ── correct fix: derive the URL from api-urls.ts instead ──
        {
            code: `
                import { entityImageUrl } from '$lib/shared/api-urls';
                const posterUrl = entityImageUrl(itemId, 'poster', 'v1');
            `,
            filename: SERVICE_PATH,
        },
    ],

    invalid: [
        // ── the real bug: watch-together.service.ts ──
        {
            code: `
                import { config } from '../config';
                const posterUrl = \`\${config.BASE_PATH}/api/v1/media/\${itemId}/images/poster\`;
            `,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'basePathUrl', data: { name: 'config', path: '/api' } }],
        },

        // ── the real bug: routes/api/v1/watch-together/parties/+server.ts ──
        {
            code: `
                import { config } from '$lib/server/config';
                const hostAvatarUrl = \`\${config.BASE_PATH}/api/v1/users/\${id}/images/avatar\`;
                const posterUrl = \`\${config.BASE_PATH}/api/v1/media/\${itemId}/images/poster\`;
            `,
            filename: ROUTE_PATH,
            errors: [
                { messageId: 'basePathUrl', data: { name: 'config', path: '/api' } },
                { messageId: 'basePathUrl', data: { name: 'config', path: '/api' } },
            ],
        },

        // ── /v1 without a leading /api segment still counts ──
        {
            code: `
                import { config as serverConfig } from '$lib/server/config';
                const href = \`\${serverConfig.BASE_PATH}/v1/media/\${id}/poster\`;
            `,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'basePathUrl', data: { name: 'serverConfig', path: '/v1' } }],
        },

        // ── /api chunk sits after the FIRST interpolation, not the second ──
        {
            code: `
                import { config } from '$lib/server/config';
                const href = \`\${prefix}\${config.BASE_PATH}/api/v1/x\`;
            `,
            filename: SERVICE_PATH,
            errors: [{ messageId: 'basePathUrl', data: { name: 'config', path: '/api' } }],
        },
    ],
});

console.log('  ✅ no-base-path-in-url: all tests passed');
