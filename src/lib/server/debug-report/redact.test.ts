// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * These tests assert the OUTPUT: no seeded marker, host, credential or path may
 * survive into a report. "A redactor was called" is not evidence.
 *
 * Markers are seeded through the REAL configSchema (every sensitive key, every
 * string key without options) and through env, URLs and free text.
 */

import { describe, it, expect } from 'vitest';
import { configSchema } from '$lib/config/schema';
import { DEBUG_REPORT_ENUM_LITERALS } from '$lib/schemas/debug-report.js';
import {
    DEBUG_REPORT_STRING_ALLOWLIST,
    assertNoSecrets,
    collectSecretValues,
    collectUserinfoPairs,
    createRedactionContext,
    expandSweepVariants,
    looksSecretName,
    redactConfigForReport,
    sanitizeDebugText,
    type RedactionContext,
    type RedactionOptions,
} from './redact.js';

const MARKER = 'MARKER_SECRET_7f3a9';
const MARKER_RE = /MARKER_SECRET_7f3a9/;

/** Hostnames from the seeded free text. None may appear unless includeHostnames is on. */
const HOSTNAMES = ['db.internal', 'valkey.svc', 'iptv.example', 'provider.example', 'discord.com'];

const DEFAULT_OPTIONS: RedactionOptions = { includeHostnames: false, includePaths: false };
const HOSTNAME_OPTIONS: RedactionOptions = { includeHostnames: true, includePaths: false };
const PATH_OPTIONS: RedactionOptions = { includeHostnames: false, includePaths: true };

const DISCORD_TOKEN = 'Qz1'.repeat(22) + 'Qz'; // 68 characters
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJNQVJLRVIifQ.c2lnbmF0dXJlMTIz';
const GHP = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const AKIA = 'AKIAIOSFODNN7EXAMPLE';
const TELEGRAM = '123456789:' + 'AAF' + 'x'.repeat(32);
const IPV6 = 'fd00::1';

/** One free-text sample per seeded credential, host, path or identity shape. */
const FREE_TEXT_SAMPLES: readonly string[] = [
    `postgres://u:${MARKER}_pw@db.internal:5432/x`,
    `redis://:${MARKER}_pw2@valkey.svc:6379`,
    `http://iptv.example:8080/live/${MARKER}_user/${MARKER}_pass/123.ts`,
    `https://discord.com/api/webhooks/123456789012345678/${DISCORD_TOKEN}`,
    `http://provider.example/get.php?username=${MARKER}_u&password=${MARKER}_p&type=m3u`,
    `Authorization: Bearer ${JWT}`,
    `token ${GHP}`,
    `key ${AKIA}`,
    `telegram ${TELEGRAM}`,
    'contact ops@example.org',
    `ip 10.1.2.3 and ${IPV6}`,
    '/mnt/media/Movies/Some Film (1999)/Some.Film.1999.mkv',
    'C:\\Media\\x.mkv',
    '\\\\nas\\share\\x',
    'ECONNREFUSED db.internal:5432',
    'getaddrinfo ENOTFOUND valkey.svc',
    'password authentication failed for user "lumastra"',
];

/** Config and env seeded with markers: every sensitive key, every plain string key. */
function seededConfig(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const sensitive = configSchema.filter((def) => def.uiHints?.sensitive === true);
    sensitive.forEach((def, index) => {
        values[def.key] = `${MARKER}_s${index}`;
    });
    const plainStrings = configSchema.filter(
        (def) =>
            def.type === 'string' &&
            (def.options?.length ?? 0) === 0 &&
            (def.validation?.options?.length ?? 0) === 0 &&
            def.uiHints?.sensitive !== true &&
            // Allow-listed keys are visible by design and are covered elsewhere.
            !DEBUG_REPORT_STRING_ALLOWLIST.includes(def.key),
    );
    plainStrings.forEach((def, index) => {
        values[def.key] = `${MARKER}_t${index}`;
    });
    return values;
}

const ENV: Record<string, string | undefined> = {
    FOO_API_TOKEN: `${MARKER}_env`,
    HOME: '/home/denis',
    DATABASE_URL: `postgres://u:${MARKER}_dburl@db.internal:5432/x`,
};

function contextFor(
    options: RedactionOptions,
    extra: Partial<RedactionContext> = {},
): RedactionContext {
    const config = seededConfig();
    return createRedactionContext({
        options,
        libraryRoots: extra.libraryRoots ? [...extra.libraryRoots] : [],
        secretValues: collectSecretValues(config, ENV),
        userinfoPairs: collectUserinfoPairs(config, ENV),
        exemptOpaque: extra.exemptOpaque ? [...extra.exemptOpaque] : [],
    });
}

describe('collectSecretValues', () => {
    it('collects every sensitive config value, the unknown secret env value and URL passwords', () => {
        const config = seededConfig();
        const values = collectSecretValues(config, ENV);
        for (const def of configSchema) {
            if (def.uiHints?.sensitive === true) {
                expect(values, `sensitive key ${def.key}`).toContain(config[def.key]);
            }
        }
        expect(values).toContain(`${MARKER}_env`);
        expect(values).toContain(`${MARKER}_dburl`);
    });

    it('ignores values shorter than six characters and env names that are not secret', () => {
        const values = collectSecretValues(
            { JELLYFINAPIKEY: 'abc' },
            { HOME: '/home/denis', SHORT_TOKEN: 'abc' },
        );
        expect(values).not.toContain('abc');
        expect(values).not.toContain('/home/denis');
    });
});

describe('expandSweepVariants', () => {
    it('returns raw, URL, JSON-escaped and base64 forms, deduplicated and longest first', () => {
        const value = 'p/s+W9';
        const variants = expandSweepVariants([value]);
        expect(variants).toContain(value);
        expect(variants).toContain(encodeURIComponent(value));
        expect(variants).toContain(Buffer.from(value).toString('base64'));
        expect(new Set(variants).size).toBe(variants.length);
        const lengths = variants.map((variant) => variant.length);
        expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
    });

    it('adds base64 of each user:pass pair and drops values under six characters', () => {
        const variants = expandSweepVariants(['abc'], ['lumastra:MARKER_SECRET_7f3a9']);
        expect(variants).toContain(Buffer.from('lumastra:MARKER_SECRET_7f3a9').toString('base64'));
        expect(variants).not.toContain('abc');
    });
});

describe('sanitizeDebugText: credentials, hosts and paths (default options)', () => {
    const ctx = contextFor(DEFAULT_OPTIONS);

    it.each(FREE_TEXT_SAMPLES)('removes markers and hostnames from %s', (sample) => {
        const out = sanitizeDebugText(sample, ctx);
        expect(out).not.toMatch(MARKER_RE);
        for (const host of HOSTNAMES) expect(out).not.toContain(host);
        expect(out).not.toContain('example.org');
        expect(out).not.toContain(JWT);
        expect(out).not.toContain(GHP);
        expect(out).not.toContain(AKIA);
        expect(out).not.toContain('123456789012345678/');
    });

    it('replaces URL authorities, paths and query strings with placeholders', () => {
        expect(sanitizeDebugText(`postgres://u:${MARKER}_pw@db.internal:5432/x`, ctx)).toBe(
            'postgres://<host>/…',
        );
        expect(sanitizeDebugText(`redis://:${MARKER}_pw2@valkey.svc:6379`, ctx)).toBe(
            'redis://<host>/…',
        );
        expect(
            sanitizeDebugText(`http://iptv.example:8080/live/${MARKER}_u/${MARKER}_p/123.ts`, ctx),
        ).toBe('http://<host>/…');
        expect(
            sanitizeDebugText(
                `https://discord.com/api/webhooks/123456789012345678/${DISCORD_TOKEN}`,
                ctx,
            ),
        ).toBe('https://<host>/…');
        expect(
            sanitizeDebugText(
                `http://provider.example/get.php?username=${MARKER}&password=${MARKER}`,
                ctx,
            ),
        ).toBe('http://<host>/…');
    });

    it('replaces emails, IPs, filesystem paths and the network and role details', () => {
        expect(sanitizeDebugText('contact ops@example.org', ctx)).toBe('contact <email>');
        expect(sanitizeDebugText('ip 10.1.2.3 and fd00::1', ctx)).toBe('ip <ip> and <ip>');
        expect(
            sanitizeDebugText('/mnt/media/Movies/Some Film (1999)/Some.Film.1999.mkv', ctx),
        ).toBe('<path>');
        expect(sanitizeDebugText('C:\\Media\\x.mkv', ctx)).toBe('<path>');
        expect(sanitizeDebugText('\\\\nas\\share\\x', ctx)).toBe('<path>');
        expect(sanitizeDebugText('ECONNREFUSED db.internal:5432', ctx)).toBe('ECONNREFUSED <host>');
        expect(sanitizeDebugText('getaddrinfo ENOTFOUND valkey.svc', ctx)).toBe(
            'getaddrinfo ENOTFOUND <host>',
        );
        expect(sanitizeDebugText('password authentication failed for user "lumastra"', ctx)).toBe(
            'password authentication failed for user "<name>"',
        );
    });

    it('replaces token shapes', () => {
        expect(sanitizeDebugText(`token ${GHP}`, ctx)).toBe('token <redacted>');
        expect(sanitizeDebugText(`key ${AKIA}`, ctx)).toBe('key <redacted>');
        expect(sanitizeDebugText(`telegram ${TELEGRAM}`, ctx)).toBe('telegram <redacted>');
        expect(sanitizeDebugText(`Authorization: Bearer ${JWT}`, ctx)).toBe(
            'Authorization: <redacted>',
        );
    });

    it('replaces key/value pairs whose key name says secret, and leaves other keys alone', () => {
        expect(sanitizeDebugText('FOO_API_TOKEN=abcdef123', ctx)).toBe('FOO_API_TOKEN=<redacted>');
        expect(sanitizeDebugText('db_password: hunter22', ctx)).toBe('db_password: <redacted>');
        expect(sanitizeDebugText('status: ready', ctx)).toBe('status: ready');
    });

    it('drops cookie and proxy headers and the extra query-parameter names', () => {
        expect(sanitizeDebugText('set-cookie: sid=abc123', ctx)).toBe('set-cookie: <redacted>');
        expect(sanitizeDebugText('proxy-authorization: Basic Zm9vOmJhcg==', ctx)).toBe(
            'proxy-authorization: <redacted>',
        );
        expect(sanitizeDebugText('/callback?access_token=abc123&state=x', ctx)).not.toContain(
            'abc123',
        );
        expect(sanitizeDebugText('/callback?code=oauthcode42&state=st8', ctx)).toBe(
            '/callback?code=<redacted>&state=<redacted>',
        );
        // The generic words are kept in prose.
        expect(sanitizeDebugText('exit code=1, state=running', ctx)).toBe(
            'exit code=1, state=running',
        );
    });
});

describe('sanitizeDebugText: include toggles', () => {
    it('with includeHostnames, keeps the host and drops credentials, ports and paths', () => {
        const ctx = contextFor(HOSTNAME_OPTIONS);
        const out = FREE_TEXT_SAMPLES.map((sample) => sanitizeDebugText(sample, ctx)).join('\n');
        expect(out).not.toMatch(MARKER_RE);
        expect(out).toContain('db.internal');
        expect(out).toContain('valkey.svc');
        expect(out).toContain('iptv.example');
        expect(out).toContain('discord.com');
        expect(out).toContain('provider.example');
        expect(out).not.toContain(':5432');
        expect(out).not.toContain(':6379');
        expect(out).not.toContain(':8080');
        expect(out).not.toContain('get.php');
        expect(out).not.toContain('/live/');
        expect(out).not.toContain('/webhooks');
        expect(out).not.toContain('username=');
        expect(out).not.toContain('123.ts');
        expect(out).not.toContain('ops@example.org');
        expect(out).toContain('<email>');
        expect(out).not.toContain('10.1.2.3');
    });

    it('with includePaths, keeps the filesystem path but never URL paths or credentials', () => {
        const ctx = contextFor(PATH_OPTIONS);
        const out = FREE_TEXT_SAMPLES.map((sample) => sanitizeDebugText(sample, ctx)).join('\n');
        expect(out).not.toMatch(MARKER_RE);
        expect(out).toContain('/mnt/media/Movies/Some Film (1999)/Some.Film.1999.mkv');
        expect(out).not.toContain('/live/');
        expect(out).not.toContain('get.php');
        expect(out).not.toContain('/webhooks');
        expect(out).toContain('<host>');
    });

    it('replaces known library roots with <library>, even with no roots left to match', () => {
        const withRoot = contextFor(DEFAULT_OPTIONS, { libraryRoots: ['/data/movies'] });
        expect(sanitizeDebugText('failed on /data/movies/Film.mkv', withRoot)).toContain(
            '<library>',
        );
        expect(sanitizeDebugText('failed on /data/movies/Film.mkv', withRoot)).not.toContain(
            'Film',
        );
        const withoutRoot = contextFor(DEFAULT_OPTIONS);
        expect(sanitizeDebugText('/data/movies/Film.mkv', withoutRoot)).toBe('<path>');
    });
});

describe('sanitizeDebugText: encoded secrets, UUIDs and placeholders', () => {
    it('sweeps URL-encoded, base64 and JSON-escaped spellings of a short secret', () => {
        const secret = 'p/s+W9';
        const ctx = createRedactionContext({
            options: DEFAULT_OPTIONS,
            libraryRoots: [],
            secretValues: [secret],
        });
        const text = [
            `a=${encodeURIComponent(secret)}`,
            `b=${Buffer.from(secret).toString('base64')}`,
        ].join(' ');
        const out = sanitizeDebugText(text, ctx);
        expect(out).not.toContain(encodeURIComponent(secret));
        expect(out).not.toContain(Buffer.from(secret).toString('base64'));
        expect(ctx.counts.sweep).toBeGreaterThan(0);
    });

    it('sweeps a JSON-escaped secret that contains quotes', () => {
        const secret = 'q"x9Lm';
        const ctx = createRedactionContext({
            options: DEFAULT_OPTIONS,
            libraryRoots: [],
            secretValues: [secret],
        });
        const jsonEscaped = JSON.stringify(secret).slice(1, -1);
        expect(sanitizeDebugText(`c=${jsonEscaped}`, ctx)).not.toContain(jsonEscaped);
    });

    it('keeps UUIDs and exempt opaque values, and redacts an unexempt opaque run', () => {
        const commit = '0123456789abcdef0123456789abcdef01234567';
        const plain = createRedactionContext({
            options: DEFAULT_OPTIONS,
            libraryRoots: [],
            secretValues: [],
        });
        expect(sanitizeDebugText('job 3f2504e0-4f89-11d3-9a0c-0305e82c3301 finished', plain)).toBe(
            'job 3f2504e0-4f89-11d3-9a0c-0305e82c3301 finished',
        );
        expect(sanitizeDebugText(`build ${commit}`, plain)).toBe('build <redacted>');

        const exempt = createRedactionContext({
            options: DEFAULT_OPTIONS,
            libraryRoots: [],
            secretValues: [],
            exemptOpaque: [commit],
        });
        expect(sanitizeDebugText(`build ${commit}`, exempt)).toBe(`build ${commit}`);
    });

    it('does not mangle placeholders on a second pass', () => {
        const ctx = contextFor(DEFAULT_OPTIONS);
        for (const sample of FREE_TEXT_SAMPLES) {
            const once = sanitizeDebugText(sample, ctx);
            expect(sanitizeDebugText(once, ctx), sample).toBe(once);
        }
        const hostOnce = sanitizeDebugText('ECONNREFUSED db.internal:5432', ctx);
        expect(hostOnce).toBe('ECONNREFUSED <host>');
    });

    it('truncates to 200 characters for untrusted text and 500 otherwise', () => {
        const ctx = contextFor(DEFAULT_OPTIONS);
        const long = 'word '.repeat(300);
        const untrusted = sanitizeDebugText(long, ctx, { untrusted: true });
        expect(untrusted.length).toBe(200);
        expect(untrusted.endsWith('…')).toBe(true);
        const trusted = sanitizeDebugText(long, ctx);
        expect(trusted.length).toBe(500);
    });

    it('counts each class of redaction it makes', () => {
        const ctx = contextFor(DEFAULT_OPTIONS);
        sanitizeDebugText('contact ops@example.org', ctx);
        sanitizeDebugText('ip 10.1.2.3', ctx);
        expect(ctx.counts.email).toBe(1);
        expect(ctx.counts.ip).toBe(1);
    });
});

describe('redactConfigForReport', () => {
    const ctx = contextFor(DEFAULT_OPTIONS);
    const state = { envOverrides: new Set<string>(), jsonOverrides: new Set<string>() };

    it('never prints a marker, from any seeded key', () => {
        const entries = redactConfigForReport(seededConfig(), state, ctx);
        expect(JSON.stringify(entries)).not.toMatch(MARKER_RE);
    });

    it('lists every schema key and every value key, sorted by key', () => {
        const values = { DATE_LOCALE: 'de-AT', NOT_IN_SCHEMA: 'x' };
        const entries = redactConfigForReport(values, state, ctx);
        const keys = entries.map((entry) => entry.key);
        expect(keys).toEqual([...keys].sort());
        for (const def of configSchema) expect(keys).toContain(def.key);
        expect(keys).toContain('NOT_IN_SCHEMA');
    });

    it('shows a value only where the schema allows it', () => {
        const values: Record<string, unknown> = {
            DATE_LOCALE: 'de-AT',
            LOG_LEVEL: 'debug',
            IMAGE_AVIF_PREGEN_MODE: 'eager',
            JELLYFINAPIKEY: `${MARKER}_jf`,
            APPEARANCE_CUSTOM_CSS: 'body{}',
        };
        const byKey = new Map(
            redactConfigForReport(values, state, ctx).map((entry) => [entry.key, entry]),
        );
        expect(byKey.get('DATE_LOCALE')).toMatchObject({ set: true, value: 'de-AT' });
        // A select is a closed choice, so its value is shown.
        expect(byKey.get('LOG_LEVEL')).toMatchObject({ set: true, value: 'debug' });
        // A string with a closed option list in validation.options is shown.
        expect(byKey.get('IMAGE_AVIF_PREGEN_MODE')).toMatchObject({ set: true, value: 'eager' });
        expect(byKey.get('JELLYFINAPIKEY')).toMatchObject({ set: true });
        expect(byKey.get('JELLYFINAPIKEY')?.value).toBeUndefined();
        expect(byKey.get('APPEARANCE_CUSTOM_CSS')?.value).toBeUndefined();
    });

    it('reports where each value comes from', () => {
        const entries = new Map(
            redactConfigForReport(
                { DATE_LOCALE: 'en-US', TMDB_LANGUAGE: 'de-DE', APP_NAME: 'Lumastra' },
                {
                    envOverrides: new Set(['DATE_LOCALE']),
                    jsonOverrides: new Set(['TMDB_LANGUAGE']),
                },
                ctx,
            ).map((entry) => [entry.key, entry]),
        );
        expect(entries.get('DATE_LOCALE')?.source).toBe('env');
        expect(entries.get('TMDB_LANGUAGE')?.source).toBe('settings');
        expect(entries.get('APP_NAME')?.source).toBe('default');
    });

    it('marks an empty value unset', () => {
        const entries = new Map(
            redactConfigForReport({ DATE_LOCALE: '' }, state, ctx).map((entry) => [
                entry.key,
                entry,
            ]),
        );
        expect(entries.get('DATE_LOCALE')?.set).toBe(false);
        expect(entries.get('DATE_LOCALE')?.value).toBeUndefined();
    });
});

describe('assertNoSecrets', () => {
    it('replaces every hit in strings and keys, counts them, and leaves the input unchanged', () => {
        const secret = `${MARKER}_assert`;
        const ctx = createRedactionContext({
            options: DEFAULT_OPTIONS,
            libraryRoots: [],
            secretValues: [secret],
        });
        const report = {
            text: `leaked ${secret} here`,
            nested: { [secret]: 1 },
            list: [secret, 'clean'],
        };
        const { report: clean, hits } = assertNoSecrets(report, ctx);
        expect(hits).toBe(3);
        expect(JSON.stringify(clean)).not.toContain(MARKER);
        expect(ctx.counts.sweep).toBe(3);
        expect(JSON.stringify(report)).toContain(secret);
    });

    it('reports zero hits for a clean report', () => {
        const ctx = contextFor(DEFAULT_OPTIONS);
        const { hits } = assertNoSecrets({ status: 'ok', count: 3 }, ctx);
        expect(hits).toBe(0);
    });
});

describe('review regressions: secret discovery and structural values', () => {
    it.each([
        'APIKEY',
        'ACCESSKEY',
        'SECRETKEY',
        'PRIVATEKEY',
        'AUTHTOKEN',
        'TOKENS',
        'SECRETS',
        'PASSWORDS',
        'PWD',
        'JWT',
        'BEARER',
        'AUTHORIZATION',
        'clientSecret',
        'X_API_KEY',
    ])('recognises secret name %s and its key/value spelling', (name) => {
        expect(looksSecretName(name)).toBe(true);
        expect(sanitizeDebugText(`${name}=short-value`, contextFor(DEFAULT_OPTIONS))).not.toContain(
            'short-value',
        );
    });

    it('ignores short plain words discovered only through a secret-looking env name', () => {
        const words = ['kubernetes', 'container', 'bare', 'true', 'debug', 'elevenchars'];
        const env = Object.fromEntries(words.map((word, index) => [`SECRET_${index}`, word]));
        const values = collectSecretValues(
            {},
            { ...env, APIKEY: 'secret-123', AUTHORIZATION: 'Twelveletters' },
        );
        for (const word of words) expect(values).not.toContain(word);
        expect(values).toContain('secret-123');
        expect(values).toContain('Twelveletters');
        expect(collectSecretValues({ TMDB_API_KEY: 'kubernetes' }, {})).toContain('kubernetes');
        expect(collectSecretValues({}, { DATABASE_URL: 'postgres://u:container@db/x' })).toContain(
            'container',
        );
    });

    it('collects every string leaf of sensitive arrays and objects, including deep leaves', () => {
        let deep: unknown = 'deep-secret-729';
        for (let i = 0; i < 12; i += 1) deep = { child: deep };
        const values = collectSecretValues(
            { TMDB_API_KEY: ['array-secret-187', { key: 'object-secret-293', deep }, 42] },
            {},
        );
        expect(values).toEqual(
            expect.arrayContaining(['array-secret-187', 'object-secret-293', 'deep-secret-729']),
        );
    });

    it('never sweeps a leaf equal to a closed report enum, but still sweeps surrounding text and keys', () => {
        const ctx = createRedactionContext({
            options: DEFAULT_OPTIONS,
            libraryRoots: [],
            secretValues: DEBUG_REPORT_ENUM_LITERALS,
        });
        const result = assertNoSecrets(
            {
                enums: DEBUG_REPORT_ENUM_LITERALS,
                prose: 'using kubernetes',
                kubernetes: 'not an enum',
            },
            ctx,
        );
        expect(result.report.enums).toEqual(DEBUG_REPORT_ENUM_LITERALS);
        expect(result.report.prose).toBe('using <redacted>');
        expect(result.hits).toBe(2);
    });

    it.each([
        ['password="my secret phrase"', 'password="<redacted>"'],
        ['password="my\nsecret phrase"', 'password="<redacted>"'],
        ['"token": "abc def"', '"token": "<redacted>"'],
        ["secret='a b'", "secret='<redacted>'"],
        [
            '{"APIKEY": "abc \\" def", "status": "ready"}',
            '{"APIKEY": "<redacted>", "status": "ready"}',
        ],
    ])('redacts the entire quoted value in %s', (input, expected) => {
        expect(sanitizeDebugText(input, contextFor(DEFAULT_OPTIONS))).toBe(expected);
    });

    it('exempts only the whole opaque run, never a run containing an exempt identifier', () => {
        const commit = '0123456789abcdef0123456789abcdef01234567';
        const ctx = contextFor(DEFAULT_OPTIONS, { exemptOpaque: [commit, 'abcdef1'] });
        expect(sanitizeDebugText(commit, ctx)).toBe(commit);
        expect(sanitizeDebugText(`prefix${commit}suffix`, ctx)).toBe('<redacted>');
        expect(sanitizeDebugText('credentialabcdef1with123456789suffix', ctx)).toBe('<redacted>');
    });
});

describe('review regressions: filenames, relative paths and hosts', () => {
    it.each([
        [
            'Failed to probe My Movie (2020) 1080p.mkv: invalid data',
            'Failed to probe <file>: invalid data',
        ],
        ['My Movie (2020) 1080p.mkv', '<file>'],
        ['file: My Movie (2020) 1080p.mkv', 'file: <file>'],
        ['copy Movies/Foo (2020)/Foo.mkv', 'copy <path>'],
        ['./rel/path/x.nfo', '<path>'],
        ['dir:/mnt/media/Movies', 'dir:<path>'],
        ['cwd:/srv/x', 'cwd:<path>'],
        ['see ./subs/foo.en.srt', 'see <path>'],
    ])('redacts %s', (input, expected) => {
        expect(sanitizeDebugText(input, contextFor(DEFAULT_OPTIONS))).toBe(expected);
        expect(sanitizeDebugText(input, contextFor(PATH_OPTIONS))).toBe(input);
    });

    it.each([
        'nfo',
        'jpg',
        'jpeg',
        'png',
        'webp',
        'txt',
        'm3u',
        'm3u8',
        'sup',
        'idx',
        'sub',
        'vtt',
        'iso',
        'cue',
        'log',
    ])('redacts a spaced .%s sidecar', (extension) => {
        expect(sanitizeDebugText(`My Movie (2020).${extension}`, contextFor(DEFAULT_OPTIONS))).toBe(
            '<file>',
        );
    });

    it.each([
        ['request to nas.example.org failed', 'request to <host> failed'],
        [
            'connection to server at "lumastra-db-rw" (10.0.0.5), port 5432 failed',
            'connection to server at "<host>" (<ip>), port 5432 failed',
        ],
        ['host "x"', 'host "<host>"'],
        ['lumastra-db-rw:5432', '<host>'],
        ['error in config.service.ts', 'error in config.service.ts'],
        ['see https://lumastra.org/guides/x', 'see https://lumastra.org/…'],
        ['https://github.com/org/private-repo', 'https://github.com/…'],
        ['lumastra.org and github.com v1.2.3 1.2.3', 'lumastra.org and github.com v1.2.3 1.2.3'],
        [
            'config.svelte config.rs config.py config.md config.yaml config.json',
            'config.svelte config.rs config.py config.md config.yaml config.json',
        ],
    ])('handles hostname context %s', (input, expected) => {
        expect(sanitizeDebugText(input, contextFor(DEFAULT_OPTIONS))).toBe(expected);
    });

    it('includes hostnames only when requested, while still removing IPs and ports', () => {
        const ctx = contextFor(HOSTNAME_OPTIONS);
        expect(
            sanitizeDebugText('nas.example.org lumastra-db-rw:5432 host "x" 10.0.0.5', ctx),
        ).toBe('nas.example.org lumastra-db-rw host "x" <ip>');
    });
});

describe('hostname token boundaries', () => {
    it('keeps entire dotted media filenames when paths are included', () => {
        const filename = '/mnt/media/Some.Film.1999.mkv';
        expect(sanitizeDebugText(filename, contextFor(PATH_OPTIONS))).toBe(filename);
    });

    it('keeps stack frames: code identifiers and source positions are not hosts', () => {
        const frame = 'TypeError: x is not a function at Object.foo (file.ts:12:5)';
        expect(sanitizeDebugText(frame, contextFor(DEFAULT_OPTIONS))).toBe(frame);
        expect(sanitizeDebugText('Promise.allSettled rejected', contextFor(DEFAULT_OPTIONS))).toBe(
            'Promise.allSettled rejected',
        );
        expect(
            sanitizeDebugText('request to nas.example.org failed', contextFor(DEFAULT_OPTIONS)),
        ).toBe('request to <host> failed');
    });

    it('keeps ISO timestamps when detecting dotless host ports', () => {
        const timestamp = '2026-10-21T10:00:00.000Z';
        expect(sanitizeDebugText(timestamp, contextFor(DEFAULT_OPTIONS))).toBe(timestamp);
    });

    it('redacts an email before private hostname detection can split its domain', () => {
        expect(sanitizeDebugText('operator@nas.internal', contextFor(DEFAULT_OPTIONS))).toBe(
            '<email>',
        );
    });
});
