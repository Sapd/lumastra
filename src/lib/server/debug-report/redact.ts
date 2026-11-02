// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redaction for the admin debug report (spec section 5).
 *
 * Two layers, both decided by the code rather than by the reviewer's eye:
 *
 *   • Config values are shown by SCHEMA, never by guessing from the key name:
 *     {@link configValueVisible}. Booleans, numbers, closed-option enums and a
 *     short reviewed allow-list only.
 *   • Free text (error lines, health reasons, run logs, ...) goes through
 *     {@link sanitizeDebugText}: credential shapes, URL authorities and paths,
 *     hosts, IPs, emails and filesystem paths become placeholders, and finally
 *     every known secret value, in its common encodings, is swept out.
 *
 * Config and env are passed in as PARAMETERS. This module never imports
 * config.service, whose import has side effects a redaction helper must not
 * trigger.
 */

import { DEBUG_REPORT_ENUM_LITERALS } from '$lib/schemas/debug-report.js';
import { configSchema, type SettingDefinition } from '$lib/config/schema';
import { REDACTED, redactConfigValues } from '$lib/shared/diagnostics-report';
import { redactPaths, stripSecrets } from '$lib/shared/transcode-failure-report';

/** Placeholders. Every replacement below produces one of these, never raw input. */
const HOST_PLACEHOLDER = '<host>';
const IP_PLACEHOLDER = '<ip>';
const EMAIL_PLACEHOLDER = '<email>';
const PATH_PLACEHOLDER = '<path>';
const LIBRARY_PLACEHOLDER = '<library>';
const FILE_PLACEHOLDER = '<file>';
const NAME_PLACEHOLDER = '<name>';

/** Length of the free-text output: 200 for untrusted text, 500 otherwise. */
const UNTRUSTED_MAX_LENGTH = 200;
const TEXT_MAX_LENGTH = 500;

/** Shorter secrets are not swept (documented limitation, spec 5.4 step 9). */
const MIN_SWEEP_LENGTH = 6;

/** Opaque runs shorter than this are never treated as credentials. */
const OPAQUE_MIN_LENGTH = 20;

export type RedactionClass =
    'secret' | 'token' | 'url' | 'host' | 'ip' | 'email' | 'path' | 'file' | 'opaque' | 'sweep';

export interface RedactionOptions {
    /** Keep hostnames (never IPs, never ports, never URL credentials). */
    includeHostnames: boolean;
    /** Keep filesystem paths and media file names. */
    includePaths: boolean;
}

export interface RedactionContext {
    readonly options: RedactionOptions;
    /** Configured library roots, longest first. May be empty. */
    readonly libraryRoots: readonly string[];
    /** Every secret variant to sweep, longest first. */
    readonly sweep: readonly string[];
    /** Opaque values that must survive the opaque-run pass, e.g. the build commit. */
    readonly exemptOpaque: readonly string[];
    /** Redactions made so far, per class. Mutated as text is sanitized. */
    readonly counts: Record<RedactionClass, number>;
}

export interface RedactionContextInput {
    options: RedactionOptions;
    libraryRoots: readonly string[];
    secretValues: readonly string[];
    exemptOpaque?: readonly string[];
    /** `user:password` pairs from URL userinfo, see {@link collectUserinfoPairs}. */
    userinfoPairs?: readonly string[];
}

/** One config row in the report. `value` is present only when the schema allows it. */
export interface ReportConfigEntry {
    key: string;
    source: 'env' | 'settings' | 'default';
    set: boolean;
    value?: string | number | boolean;
}

/**
 * String settings whose value may appear in the report even though they are
 * free strings. Each one is a locale, a language tag or a codec list: none is
 * a credential or an identity. Every entry still goes through the free-text
 * pass. Keep this list short; a new entry needs a reason here.
 */
export const DEBUG_REPORT_STRING_ALLOWLIST: readonly string[] = [
    // BCP 47 tag for date formatting (e.g. en-US). A locale, not an identity.
    'DATE_LOCALE',
    // BCP 47 tag that TMDB metadata is requested in (e.g. en-US).
    'TMDB_LANGUAGE',
    // Comma-separated codec names for hardware decode (h264, hevc, ...).
    'HW_DECODE_CODECS',
    // Comma-separated codec names in software-encoder priority order.
    'SOFTWARE_CODEC_PREFERENCE',
];

// ---------------------------------------------------------------------------
// Secret discovery
// ---------------------------------------------------------------------------

/** Env/key name segments (split on `_`, `-`, `.` and camelCase) that mark a secret. */
const SECRET_NAME_SEGMENTS: ReadonlySet<string> = new Set([
    'KEY',
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'PASSWD',
    'PASS',
    'CREDENTIAL',
    'PRIVATE',
    'DSN',
    'SALT',
    'COOKIE',
    'SIGNING',
]);

/** True when a config or env NAME says its value is a credential. */
export function looksSecretName(name: string): boolean {
    const segments = name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .split(/[^A-Za-z0-9]+/)
        .filter((segment) => segment.length > 0)
        .map((segment) => segment.toUpperCase());
    return (
        segments.some((segment) => SECRET_NAME_SEGMENTS.has(segment)) ||
        /APIKEY|ACCESSKEY|SECRET|PASSW|PASSWD|PWD|TOKEN|CREDENTIAL|PRIVATEKEY|SIGNING|COOKIE|AUTHORIZATION|JWT|BEARER/.test(
            name.toUpperCase(),
        )
    );
}

interface UserinfoPair {
    user: string;
    password: string;
}

/** `scheme://user:password@` occurrences in one string. */
const USERINFO_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/([^\s/@:'"<>]*):([^\s/@'"<>]+)@/g;

function extractUserinfo(text: string): UserinfoPair[] {
    const pairs: UserinfoPair[] = [];
    for (const match of text.matchAll(USERINFO_RE)) {
        pairs.push({ user: match[1] ?? '', password: match[2] ?? '' });
    }
    return pairs;
}

/** Every string leaf of a config or env-shaped value, without revisiting cycles. */
function collectStrings(node: unknown, out: string[], seen = new WeakSet<object>()): void {
    if (node !== null && typeof node === 'object') {
        if (seen.has(node)) return;
        seen.add(node);
    }
    if (typeof node === 'string') {
        out.push(node);
    } else if (Array.isArray(node)) {
        for (const entry of node) collectStrings(entry, out, seen);
    } else if (node !== null && typeof node === 'object') {
        for (const entry of Object.values(node)) collectStrings(entry, out, seen);
    }
}

function safeDecode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

/** Every URL-userinfo occurrence in config values and env values. */
function userinfoPairsOf(
    rawConfig: Record<string, unknown>,
    env: Record<string, string | undefined>,
): UserinfoPair[] {
    const strings: string[] = [];
    collectStrings(rawConfig, strings);
    collectStrings(Object.values(env), strings);
    return strings.flatMap((text) => extractUserinfo(text));
}

/**
 * Secret values to sweep out of free text (spec 5.4 step 9):
 *   - every non-empty value of a `uiHints.sensitive` config key, from the config
 *     or from the env var of the same name;
 *   - every env value whose NAME looks secret;
 *   - the password part of every URL with userinfo in config or env values,
 *     plus its percent-decoded form.
 * Only values of at least six characters are returned.
 */
export function collectSecretValues(
    rawConfig: Record<string, unknown>,
    env: Record<string, string | undefined>,
): string[] {
    const values = new Set<string>();
    const add = (candidate: unknown): void => {
        if (typeof candidate === 'string' && candidate.length >= MIN_SWEEP_LENGTH) {
            values.add(candidate);
        }
    };

    for (const def of configSchema) {
        if (def.uiHints?.sensitive !== true) continue;
        const leaves: string[] = [];
        collectStrings(rawConfig[def.key], leaves);
        collectStrings(env[def.key], leaves);
        for (const leaf of leaves) add(leaf);
    }
    for (const [name, value] of Object.entries(env)) {
        // A secret-looking env name alone is weak evidence for short plain words.
        if (looksSecretName(name) && !(value && /^[a-z]{1,11}$/i.test(value))) add(value);
    }
    for (const pair of userinfoPairsOf(rawConfig, env)) {
        add(pair.password);
        add(safeDecode(pair.password));
    }
    return [...values];
}

/** The `user:password` text of each URL userinfo pair, for the base64 sweep variant. */
export function collectUserinfoPairs(
    rawConfig: Record<string, unknown>,
    env: Record<string, string | undefined>,
): string[] {
    const pairs = new Set<string>();
    for (const pair of userinfoPairsOf(rawConfig, env)) {
        pairs.add(`${pair.user}:${pair.password}`);
    }
    return [...pairs];
}

// ---------------------------------------------------------------------------
// Sweep variants
// ---------------------------------------------------------------------------

function tryTransform(value: string, transform: (text: string) => string): string | null {
    try {
        return transform(value);
    } catch {
        // A lone surrogate cannot be URI-encoded; the other variants still apply.
        return null;
    }
}

function toBase64Url(base64: string): string {
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Every spelling of each value that could appear in a report: raw,
 * `encodeURIComponent`, `encodeURI`, JSON-escaped, base64 and base64url. Each
 * `user:pass` pair also adds its base64 and base64url forms. Deduplicated, at
 * least {@link MIN_SWEEP_LENGTH} characters, longest first.
 */
export function expandSweepVariants(
    values: readonly string[],
    userinfoPairs: readonly string[] = [],
): string[] {
    const variants = new Set<string>();
    const add = (candidate: string | null): void => {
        if (candidate !== null && candidate.length >= MIN_SWEEP_LENGTH) variants.add(candidate);
    };

    for (const value of values) {
        add(value);
        add(tryTransform(value, encodeURIComponent));
        add(tryTransform(value, encodeURI));
        add(tryTransform(value, (text) => JSON.stringify(text).slice(1, -1)));
        const base64 = Buffer.from(value, 'utf8').toString('base64');
        add(base64);
        add(toBase64Url(base64));
    }
    for (const pair of userinfoPairs) {
        const base64 = Buffer.from(pair, 'utf8').toString('base64');
        add(base64);
        add(toBase64Url(base64));
    }
    return [...variants].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function zeroCounts(): Record<RedactionClass, number> {
    return {
        secret: 0,
        token: 0,
        url: 0,
        host: 0,
        ip: 0,
        email: 0,
        path: 0,
        file: 0,
        opaque: 0,
        sweep: 0,
    };
}

/** Build the context for one report. `secretValues` and `userinfoPairs` come from the caller. */
export function createRedactionContext(input: RedactionContextInput): RedactionContext {
    return {
        options: {
            includeHostnames: input.options.includeHostnames,
            includePaths: input.options.includePaths,
        },
        // A root of "/" or an empty string would turn every absolute path into <library>.
        libraryRoots: [...input.libraryRoots]
            .filter((root) => root.trim().length > 1)
            .sort((a, b) => b.length - a.length),
        sweep: expandSweepVariants(input.secretValues, input.userinfoPairs ?? []),
        exemptOpaque: [...(input.exemptOpaque ?? [])].filter((value) => value.length > 0),
        counts: zeroCounts(),
    };
}

// ---------------------------------------------------------------------------
// Free-text patterns
// ---------------------------------------------------------------------------

/** Query parameters and headers that `stripSecrets` does not cover yet (spec 5.4 step 1). */
const EXTRA_PARAM_RE = /\b(access_token|refresh_token|signature|x-amz-signature)=([^&'"\s]+)/gi;
/**
 * Generic words (`code`, `state`, `sid`, `session`) are secret only as URL query
 * parameters, where OAuth codes and session ids travel; in prose ("exit
 * code=1", "state=running") they are kept.
 */
const QUERY_ONLY_PARAM_RE = /([?&])(code|state|sid|session)=([^&'"\s#]+)/gi;
const EXTRA_HEADER_RE =
    /\b(cookie|set-cookie|proxy-authorization|x-api-key|x-forwarded-for)\s*:\s*([^\r\n'"]+)/gi;

/** `Bearer <token>` in free text. Keeps the word, drops the token. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** Token shapes (spec 5.4 step 2). Each match becomes a plain placeholder. */
const TOKEN_SHAPE_RES: readonly RegExp[] = [
    /\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g,
    /\b(?:pat|svc)_[A-Za-z0-9_-]{8,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bglpat-[A-Za-z0-9_-]{20,}/g,
    /\bxox[bp]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
    /\b\d+:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
];

/** `name: value` / `name=value` (quotes around the separator allowed). Secret-named keys only. */
const QUOTED_KEY_VALUE_RE =
    /\b([A-Za-z][\w.-]*)(["']?\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/g;
const KEY_VALUE_RE =
    /\b([A-Za-z][\w.-]*)(["']?\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;'"&<>}\]]+)/g;

/** Any `scheme://…`. Everything after the scheme is one URL, so placeholders inside it are absorbed. */
const URL_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}):\/\/[^\s'"\\]*/g;

/** `user:password@` with no scheme in front (spec 5.4 step 2 spirit, after URLs). */
const BARE_USERINFO_RE = /\b[A-Za-z0-9._%+-]+:[^\s/@'"]+@/g;

/** `host:port`, including dotless service names. Numeric hosts are handled as IPs. */
const HOST_PORT_RE = /\b([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})\b/g;
const QUOTED_HOST_RE = /\b(host|server\s+at)(\s+)"[^"\r\n]*"/gi;
/** Consume the whole dotted token so a filename such as Film.2020.mkv is not half a host. */
const FQDN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi;
const PUBLIC_HOSTS: ReadonlySet<string> = new Set(['lumastra.org', 'github.com']);

/** Socket error codes followed by a target (spec 5.4 step 4). */
const NETWORK_ERROR_RE =
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)(\s+)([A-Za-z0-9][A-Za-z0-9.-]*)/g;

/** Names under private suffixes, which are never public (spec 5.4 step 4). */
const INTERNAL_HOST_RE =
    /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|local|svc|lan)\b(?!\.[A-Za-z0-9-])/g;

/** Database / role / user names inside quotes. */
const DB_NAME_RE = /\b(user|role|database)(\s+)"[^"\r\n]*"/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV4_EXACT_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE =
    /(?<![\w:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?|::[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})(?![\w:])/g;

/** Library-root replacement left behind by `redactPaths` (its `<media>/<redacted>` shape). */
const REDACTED_ROOT_RE = /<media>\/<redacted>(?:\.[A-Za-z0-9]+)?/g;

/** Media, subtitle and sidecar extensions. */
const MEDIA_EXTENSIONS =
    'mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|flac|mp3|m4a|aac|ogg|opus|wav|srt|ass|ssa|nfo|jpg|jpeg|png|webp|txt|m3u|m3u8|sup|idx|sub|vtt|iso|cue|log';
const NON_HOST_EXTENSIONS: ReadonlySet<string> = new Set(
    `${MEDIA_EXTENSIONS}|js|mjs|cjs|json|svelte|rs|py|go|md|yaml|yml|toml|sql|html|css|map`.split(
        '|',
    ),
);

/** Absolute and relative paths. URL slashes and placeholders cannot start a path. */
const PATH_RE = new RegExp(
    [
        String.raw`(?<![\w./<>\\])\/(?:[^/\r\n'"<>|]+\/)+[^/\r\n'"<>|]*?\.[A-Za-z0-9]{1,5}(?![A-Za-z0-9.])`,
        String.raw`(?<![\w./<>\\])\/[^/\s'"\\<>|]+(?:\/[^/\s'"\\<>|]+)+`,
        String.raw`\b[A-Za-z]:\\(?:[^\\\r\n'"<>|]+\\)*[^\\\r\n'"<>|]*?\.[A-Za-z0-9]{1,5}(?![A-Za-z0-9.])`,
        String.raw`\b[A-Za-z]:\\[^\\\s'"<>|]+(?:\\[^\\\s'"<>|]+)*`,
        String.raw`(?<![\\\w])\\\\[^\\\s'"<>|]+(?:\\[^\\\s'"<>|]+)*`,
        String.raw`(?<![\w.:/<>\\])(?:\.\.?/)?[A-Za-z0-9_.-]+/(?:[^/\\\r\n'"<>|]+/)*[^/\\\r\n'"<>|]*?\.(?:${MEDIA_EXTENSIONS})(?![A-Za-z0-9])`,
    ].join('|'),
    'gi',
);

/** A spaced filename ends at its extension; punctuation and path separators bound it. */
const FILE_RE = new RegExp(
    // `(?!:\d)`: `file.ts:12:5` is a source position in a stack frame, not a
    // media file (`.ts` is also MPEG-TS).
    String.raw`[^/\\"'<>|\r\n:]*?\.(?:${MEDIA_EXTENSIONS})(?![A-Za-z0-9])(?!:\d)`,
    'gi',
);

/** Preserve common prose preceding a filename, and separators introducing it. */
function filenamePrefix(text: string): string {
    const boundary =
        /^(?:.*?,[ \t]+|[ \t]*(?:Failed to (?:probe|open|read)|probe|open|read|copy|see)[ \t]+|[ \t]*\(|[ \t]+)/i.exec(
            text,
        );
    return boundary?.[0] ?? '';
}

/** Runs that may be a credential. Mixed letters and digits, at least 20 characters. */
const OPAQUE_RUN_RE = /[A-Za-z0-9+/_-]{20,}/g;

const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Splits a run around UUIDs; odd indexes of the result are the UUIDs themselves. */
const UUID_SPLIT_RE = new RegExp(`(${UUID_SRC})`, 'i');

function placeholderCount(text: string): number {
    return text.split(REDACTED).length - 1;
}

function isExempt(value: string, ctx: RedactionContext): boolean {
    // Exemptions are full identifiers (a commit), so a short value is never one.
    return ctx.exemptOpaque.some((exempt) => exempt.length >= 7 && value === exempt);
}

/** Redact the non-UUID parts of one opaque run. UUIDs and exempt values survive. */
function redactOpaqueRun(run: string, ctx: RedactionContext): string {
    return run
        .split(UUID_SPLIT_RE)
        .map((part, index) => {
            if (index % 2 === 1) return part;
            const mixed = /[A-Za-z]/.test(part) && /[0-9]/.test(part);
            if (part.length < OPAQUE_MIN_LENGTH || !mixed || isExempt(part, ctx)) return part;
            ctx.counts.opaque += 1;
            return REDACTED;
        })
        .join('');
}

/** `scheme://host/…`: userinfo, port, path, query and fragment are always dropped. */
function redactUrl(scheme: string, rest: string, includeHostnames: boolean): string {
    const authority = rest.split(/[/?#]/, 1)[0] ?? '';
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const host = hostPort.replace(/^\[([^\]]*)\].*$/, '$1').replace(/:\d*$/, '');
    if ((!includeHostnames && !PUBLIC_HOSTS.has(host.toLowerCase())) || host === '') {
        return `${scheme}://${HOST_PLACEHOLDER}/…`;
    }
    return `${scheme}://${host}/…`;
}

/** Replace every known secret value with `<redacted>`, counting the hits. */
function sweepKnownSecrets(text: string, ctx: RedactionContext): string {
    let out = text;
    for (const variant of ctx.sweep) {
        if (!out.includes(variant)) continue;
        const parts = out.split(variant);
        ctx.counts.sweep += parts.length - 1;
        out = parts.join(REDACTED);
    }
    return out;
}

/**
 * Sanitize one free-text field for the report. Steps follow spec 5.4 in order,
 * with two adjustments noted inline: the known-secret sweep also runs before
 * truncation, so a secret is never cut in half, and the library roots are
 * handled by {@link redactPaths} before the generic path pass.
 *
 * Idempotent: placeholders produced here are not mangled by a second run.
 */
export function sanitizeDebugText(
    text: string,
    ctx: RedactionContext,
    opts?: { untrusted?: boolean },
): string {
    const { includeHostnames, includePaths } = ctx.options;
    const counts = ctx.counts;
    const maxLength = opts?.untrusted === true ? UNTRUSTED_MAX_LENGTH : TEXT_MAX_LENGTH;

    const redactPair = (match: string, name: string, separator: string, value: string): string => {
        if (!looksSecretName(name)) return match;
        const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
        if ((quote ? value.slice(1, -1) : value) === REDACTED) return match;
        counts.secret += 1;
        return `${name}${separator}${quote}${REDACTED}${quote}`;
    };
    // Quoted values must be consumed before stripSecrets can redact just their first word.
    const quoted = text.replace(QUOTED_KEY_VALUE_RE, redactPair);
    // 1. Credentials in known wire shapes, then the wider set this report adds.
    const stripped = stripSecrets(quoted);
    counts.secret += placeholderCount(stripped) - placeholderCount(quoted);
    let out = stripped
        .replace(EXTRA_PARAM_RE, (_match: string, key: string) => {
            counts.secret += 1;
            return `${key}=${REDACTED}`;
        })
        .replace(QUERY_ONLY_PARAM_RE, (_match: string, sep: string, key: string) => {
            counts.secret += 1;
            return `${sep}${key}=${REDACTED}`;
        })
        .replace(EXTRA_HEADER_RE, (_match: string, name: string) => {
            counts.secret += 1;
            return `${name}: ${REDACTED}`;
        });

    // 2. Token shapes and key/value pairs with a secret-looking name.
    out = out.replace(BEARER_RE, () => {
        counts.token += 1;
        return `Bearer ${REDACTED}`;
    });
    for (const re of TOKEN_SHAPE_RES) {
        out = out.replace(re, () => {
            counts.token += 1;
            return REDACTED;
        });
    }
    out = out.replace(KEY_VALUE_RE, redactPair);

    // 3. URLs of any scheme, and userinfo without a scheme in front.
    out = out.replace(URL_RE, (match: string, scheme: string) => {
        counts.url += 1;
        return redactUrl(scheme, match.slice(scheme.length + 3), includeHostnames);
    });
    out = out.replace(BARE_USERINFO_RE, () => {
        counts.secret += 1;
        return `${REDACTED}@`;
    });

    // Emails must be removed before a hostname pass can split their domain.
    out = out.replace(EMAIL_RE, () => {
        counts.email += 1;
        return EMAIL_PLACEHOLDER;
    });

    // 4. Network detail without a scheme.
    out = out.replace(HOST_PORT_RE, (match: string, host: string) => {
        if (
            !/[A-Za-z]/.test(host) ||
            IPV4_EXACT_RE.test(host) ||
            /^\d{4}-\d{2}-\d{2}T\d{2}$/i.test(host) ||
            // `file.ts:12` in a stack frame is a source position, not a host.
            NON_HOST_EXTENSIONS.has(host.toLowerCase().split('.').at(-1) ?? '')
        ) {
            return match;
        }
        counts.host += 1;
        return includeHostnames || PUBLIC_HOSTS.has(host.toLowerCase()) ? host : HOST_PLACEHOLDER;
    });
    out = out.replace(
        NETWORK_ERROR_RE,
        (match: string, code: string, space: string, target: string) => {
            if (IPV4_EXACT_RE.test(target)) return match;
            counts.host += 1;
            return `${code}${space}${includeHostnames || PUBLIC_HOSTS.has(target.toLowerCase()) ? target : HOST_PLACEHOLDER}`;
        },
    );
    out = out.replace(INTERNAL_HOST_RE, (match: string) => {
        if (includeHostnames) return match;
        counts.host += 1;
        return HOST_PLACEHOLDER;
    });
    out = out.replace(QUOTED_HOST_RE, (match: string, keyword: string, space: string) => {
        if (includeHostnames) return match;
        counts.host += 1;
        return `${keyword}${space}"${HOST_PLACEHOLDER}"`;
    });
    out = out.replace(DB_NAME_RE, (_match: string, keyword: string, space: string) => {
        counts.secret += 1;
        return `${keyword}${space}"${NAME_PLACEHOLDER}"`;
    });

    // 5. IPv4 and IPv6 (IPv4 first, so "::ffff:1.2.3.4" is not half-matched).
    out = out.replace(IPV4_RE, () => {
        counts.ip += 1;
        return IP_PLACEHOLDER;
    });
    out = out.replace(IPV6_RE, () => {
        counts.ip += 1;
        return IP_PLACEHOLDER;
    });

    out = out.replace(FQDN_RE, (match: string) => {
        const lower = match.toLowerCase();
        const extension = lower.split('.').at(-1) ?? '';
        if (
            includeHostnames ||
            // Host names are written in lower case; `Object.keys` or
            // `Promise.allSettled` in an error line are code, not hosts.
            match !== lower ||
            !/^[a-z]{2,24}$/.test(extension) ||
            PUBLIC_HOSTS.has(lower) ||
            NON_HOST_EXTENSIONS.has(extension) ||
            /^v?\d+(?:\.[a-z0-9-]+)+$/i.test(match)
        ) {
            return match;
        }
        counts.host += 1;
        return HOST_PLACEHOLDER;
    });

    // 6. Filesystem paths and media file names. Paths are kept only with includePaths.
    if (!includePaths && ctx.libraryRoots.length > 0) {
        out = redactPaths(out, { libraryRoots: [...ctx.libraryRoots] }).replace(
            REDACTED_ROOT_RE,
            () => {
                counts.path += 1;
                return LIBRARY_PLACEHOLDER;
            },
        );
    }
    out = out.replace(PATH_RE, (match: string) => {
        if (includePaths) return match;
        counts.path += 1;
        return PATH_PLACEHOLDER;
    });
    out = out.replace(FILE_RE, (match: string) => {
        if (includePaths) return match;
        if (/\b[\w.-]+\.(?:service|test|spec|d|queries)\.ts$/i.test(match)) return match;
        counts.file += 1;
        return `${filenamePrefix(match)}${FILE_PLACEHOLDER}`;
    });

    // 7. Opaque runs that look like credentials. UUIDs and exempt values survive.
    out = out.replace(OPAQUE_RUN_RE, (run: string) => redactOpaqueRun(run, ctx));

    // Sweep before truncating too: a secret cut at the boundary would otherwise
    // reach the output as an unswept prefix.
    out = sweepKnownSecrets(out, ctx);

    // 8. Truncate. The ellipsis counts toward the limit.
    if (out.length > maxLength) out = `${out.slice(0, maxLength - 1)}…`;

    // 9. Known-secret sweep on the final text.
    return sweepKnownSecrets(out, ctx);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** True when the schema lists a closed set of values (top-level or validation). */
function hasClosedOptions(def: SettingDefinition): boolean {
    return (def.options?.length ?? 0) > 0 || (def.validation?.options?.length ?? 0) > 0;
}

/** True when `redactConfigValues` would replace this key's value, for any value. */
function maskedByRedaction(key: string, def: SettingDefinition): boolean {
    const sensitive = def.uiHints?.sensitive === true;
    const probe = redactConfigValues({ [key]: 'probe' }, () => sensitive);
    return probe[key] !== 'probe';
}

/**
 * Whether a config value may appear in the report (spec 5.3). True only for
 * boolean and number settings, string settings with a closed option list, and
 * the allow-list. Never for a key that `redactConfigValues` masks.
 */
export function configValueVisible(key: string, def: SettingDefinition | undefined): boolean {
    if (def === undefined) return false;
    if (maskedByRedaction(key, def) || looksSecretName(key)) return false;
    if (
        def.type === 'number' &&
        /(^|_)(ID|IDS|UID|GID|CHAT_ID|USER_ID|GROUP_ID|ACCOUNT)($|_)/.test(key)
    ) {
        return false;
    }
    if (def.type === 'boolean' || def.type === 'number') return true;
    // A select is a closed choice by construction; a string only with an option list.
    if (def.type === 'select') return true;
    if (def.type === 'string' && hasClosedOptions(def)) return true;
    return DEBUG_REPORT_STRING_ALLOWLIST.includes(key);
}

function isSetValue(value: unknown): boolean {
    if (value === undefined || value === null || value === '') return false;
    return !(Array.isArray(value) && value.length === 0);
}

/**
 * One row per key, from the values and from every schema key, sorted by key.
 * A key shows its value only when {@link configValueVisible} allows it; a
 * visible string still goes through {@link sanitizeDebugText}.
 */
export function redactConfigForReport(
    values: Record<string, unknown>,
    state: { envOverrides: ReadonlySet<string>; jsonOverrides: ReadonlySet<string> },
    ctx: RedactionContext,
): ReportConfigEntry[] {
    const defs = new Map<string, SettingDefinition>(configSchema.map((def) => [def.key, def]));
    const keys = new Set<string>([...Object.keys(values), ...defs.keys()]);

    return [...keys].sort().map((key): ReportConfigEntry => {
        const raw = values[key];
        const source = state.envOverrides.has(key)
            ? 'env'
            : state.jsonOverrides.has(key)
              ? 'settings'
              : 'default';
        const entry: ReportConfigEntry = { key, source, set: isSetValue(raw) };
        if (!entry.set || !configValueVisible(key, defs.get(key))) return entry;

        if (typeof raw === 'string') {
            entry.value = sanitizeDebugText(raw, ctx);
        } else if (typeof raw === 'number' || typeof raw === 'boolean') {
            entry.value = raw;
        }
        return entry;
    });
}

// ---------------------------------------------------------------------------
// Final assertion
// ---------------------------------------------------------------------------

/**
 * Walk every string leaf AND object key of the report (deep copy, the input is
 * not mutated). Every known-secret variant found is replaced with `<redacted>`
 * and counted. A non-zero `hits` means a section bypassed the redactor.
 */
export function assertNoSecrets<T>(report: T, ctx: RedactionContext): { report: T; hits: number } {
    let hits = 0;
    const scrub = (text: string): string => {
        let out = text;
        for (const variant of ctx.sweep) {
            if (!out.includes(variant)) continue;
            const parts = out.split(variant);
            hits += parts.length - 1;
            out = parts.join(REDACTED);
        }
        return out;
    };
    const walk = (node: unknown): unknown => {
        if (typeof node === 'string') {
            return DEBUG_REPORT_ENUM_LITERALS.includes(node) ? node : scrub(node);
        }
        if (Array.isArray(node)) return node.map((entry: unknown) => walk(entry));
        if (node !== null && typeof node === 'object') {
            const copy: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(node)) {
                copy[scrub(key)] = walk(entry);
            }
            return copy;
        }
        return node;
    };

    const clean = walk(report) as T;
    ctx.counts.sweep += hits;
    return { report: clean, hits };
}
