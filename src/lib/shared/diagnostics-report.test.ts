// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * These tests assert the redacted OUTPUT of the config helpers, not that a redactor
 * was called. The debug report is pasted into public issues, so "the pipeline calls
 * redactConfigValues somewhere" is not evidence of anything. The report's own
 * end-to-end redaction tests live in `$lib/server/debug-report/`.
 */

import { describe, it, expect } from 'vitest';
import { configSchema } from '$lib/config/schema.js';
import { redactConfigValues, isRedactionAvailable, REDACTED, UNSET } from './diagnostics-report.js';

/** The real predicate the server uses, rebuilt from the schema so the fixtures
 *  below exercise ACTUAL sensitive keys rather than made-up ones. */
function isSensitiveKey(key: string): boolean {
    return configSchema.find((s) => s.key === key)?.uiHints?.sensitive === true;
}

const sensitiveKeys = configSchema
    .filter((s) => s.uiHints?.sensitive === true)
    .map((s) => s.key)
    .sort();

describe('redactConfigValues', () => {
    it('masks EVERY schema key flagged sensitive and leaves other values untouched', () => {
        expect(sensitiveKeys.length).toBeGreaterThan(10);

        const values: Record<string, unknown> = {
            TMDB_LANGUAGE: 'en-US',
            FFMPEG_TRANSCODE_DIR: '/tmp/transcode',
            TASK_CONCURRENCY: 4,
            SOME_LIST: ['a', 'b'],
        };
        for (const key of sensitiveKeys) values[key] = `super-secret-${key}`;

        const redacted = redactConfigValues(values, isSensitiveKey);

        for (const key of sensitiveKeys) {
            expect(redacted[key], `${key} must be masked`).toBe(REDACTED);
        }
        // Nothing anywhere in the serialized result still carries the marker.
        expect(JSON.stringify(redacted)).not.toContain('super-secret-');

        expect(redacted.TMDB_LANGUAGE).toBe('en-US');
        expect(redacted.FFMPEG_TRANSCODE_DIR).toBe(REDACTED);
        expect(redacted.TASK_CONCURRENCY).toBe(4);
        expect(redacted.SOME_LIST).toEqual(['a', 'b']);
    });

    it('reports an empty/null sensitive value as unset instead of pretending a secret exists', () => {
        const key = sensitiveKeys[0];
        expect(redactConfigValues({ [key]: '' }, isSensitiveKey)[key]).toBe(UNSET);
        expect(redactConfigValues({ [key]: null }, isSensitiveKey)[key]).toBe(UNSET);
        expect(redactConfigValues({ [key]: undefined }, isSensitiveKey)[key]).toBe(UNSET);
        expect(redactConfigValues({ [key]: [] }, isSensitiveKey)[key]).toBe(UNSET);
        // …but a real value is still masked, never passed through.
        expect(redactConfigValues({ [key]: 'abc' }, isSensitiveKey)[key]).toBe(REDACTED);
    });

    it('masks a non-string sensitive value without leaking its contents', () => {
        const key = sensitiveKeys[0];
        const redacted = redactConfigValues({ [key]: ['tok-1', 'tok-2'] }, isSensitiveKey);
        expect(redacted[key]).toBe(REDACTED);
        expect(JSON.stringify(redacted)).not.toContain('tok-1');
    });

    // Not credentials, so `uiHints.sensitive` does not (and should not) flag
    // them — but they name the operator, and the bundle is pasted in public.
    it.each(['DEFAULT_USER', 'AUTH_OIDC_CLIENT_ID'])(
        'masks the identity-bearing key %s even though the schema does not flag it sensitive',
        (key) => {
            expect(isSensitiveKey(key)).toBe(false);
            expect(redactConfigValues({ [key]: 'denis' }, isSensitiveKey)[key]).toBe(REDACTED);
            // …while "is it even configured?" still gets an honest answer.
            expect(redactConfigValues({ [key]: '' }, isSensitiveKey)[key]).toBe(UNSET);
        },
    );

    it('masks public-report-only instance metadata without changing the settings schema', () => {
        const values: Record<string, unknown> = {
            WATCH_PERMISSION_GROUPS: ['Librarians', 'StreamMonitors'],
            USERHEADER: 'x-authentik-username',
            PREVIEW_CACHE_DIR: '/config/cache/preview',
            VAAPI_DEVICE: '/dev/dri/renderD128',
            PUBLIC_BASE_URL: 'https://media.example.test',
            CORS_ALLOWED_ORIGINS: 'https://app.example.test',
            TRAKT_CLIENT_ID: 'operator-registered-client',
            SIDEBAR_LINKS: [{ id: 'persistent-id', label: 'Grafana', groups: ['Librarians'] }],
        };

        const redacted = redactConfigValues(values, isSensitiveKey);

        for (const [key, value] of Object.entries(values)) {
            expect(redacted[key], `${key} must be masked in a public report`).toBe(REDACTED);
            expect(JSON.stringify(redacted)).not.toContain(String(value));
        }
    });
});

describe('isRedactionAvailable', () => {
    // `redactPaths` iterates `libraryRoots`; an empty array makes the whole path
    // pass a no-op, so the report would ship unredacted under a banner that says
    // otherwise. The empty array also arrives when the library-paths QUERY
    // failed (the service falls back to []), which is exactly when it must not
    // pass silently.
    it('is false when there are no library roots to match against', () => {
        expect(isRedactionAvailable({ libraryRoots: [] })).toBe(false);
    });

    it('is true once at least one library root is known', () => {
        expect(isRedactionAvailable({ libraryRoots: ['/mnt/media'] })).toBe(true);
    });
});
