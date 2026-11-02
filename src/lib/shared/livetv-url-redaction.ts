// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Credential redaction for Live TV (IPTV) URLs.
 *
 * An IPTV source URL is the user's paid SUBSCRIPTION, and providers almost never
 * put the credential in URL userinfo. The Xtream Codes family puts it IN THE PATH
 * or the QUERY:
 *
 *   http://host:8080/playlist/<user>/<pass>/m3u_plus
 *   http://host:8080/epg/<user>/<pass>
 *   http://host/live/<user>/<pass>/<id>.ts          (also movie/series/timeshift)
 *   http://host/<user>/<pass>/<id>                  (short stream form)
 *   http://host/get.php?username=U&password=P&type=m3u_plus
 *   http://host/xmltv.php?username=U&password=P
 *
 * A failed refresh logged the full URL on every run, so the subscription landed in
 * the worker log verbatim. Everything that logs, stores or returns a Live TV URL
 * outside the admin source-edit form goes through this module.
 *
 * Scheme, host and port are kept — "which provider, over plain http, on :8080" is
 * the diagnostic value of the URL — and everything that can carry the credential
 * is masked with `***`.
 *
 * Lives in $lib/shared (not under the server livetv services) so the $lib/shared
 * failure-report scrubbers and the server code run the same rules.
 */

const MASK = '***';

/**
 * Path prefixes after which the next TWO segments are `<user>/<pass>` in the
 * Xtream Codes URL scheme.
 */
const XTREAM_PATH_PREFIXES = new Set(['playlist', 'epg', 'live', 'movie', 'series', 'timeshift']);

/**
 * Query-parameter names whose value is a credential. Compared on a NORMALIZED key
 * (lowercased, `-`/`_` dropped) so `api_key`, `apiKey` and `API-KEY` collapse.
 */
const SECRET_QUERY_KEYS = new Set([
    'username',
    'user',
    'usr',
    'login',
    'password',
    'pass',
    'passwd',
    'pwd',
    'token',
    'auth',
    'key',
    'apikey',
    'secret',
    'sig',
    'signature',
    'hash',
    'mac',
    'streamtoken',
    'accesstoken',
    'authtoken',
    'xembytoken',
]);

/** Substrings that mark a query key as a credential even in compounds
 *  (`subscriberToken`, `client_secret`, `userPassword`). */
const SECRET_QUERY_NEEDLES = ['token', 'password', 'passwd', 'secret', 'apikey'];

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[-_]/g, '');
}

function isSecretQueryKey(rawKey: string): boolean {
    let key: string;
    try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
        key = rawKey;
    }
    const norm = normalizeKey(key);
    return SECRET_QUERY_KEYS.has(norm) || SECRET_QUERY_NEEDLES.some((n) => norm.includes(n));
}

/**
 * Conservative fallback for credentials in positions no rule knows about (the
 * short Xtream stream form `/<user>/<pass>/<id>`, a provider-specific token path).
 *
 * A value is treated as opaque when it contains an unbroken alphanumeric run of at
 * least 8 characters mixing letters AND digits. Separators (`_ - . ~`) break a run,
 * so word-ish values (`m3u_plus`, `index.m3u8`, `playlist`) and pure numbers
 * (stream ids, dates) stay readable, while `a8Fk29xQ`, a UUID or a hex token do not.
 */
function isOpaqueToken(value: string): boolean {
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        decoded = value;
    }
    return (decoded.match(/[A-Za-z0-9]{8,}/g) ?? []).some(
        (run) => /[A-Za-z]/.test(run) && /[0-9]/.test(run),
    );
}

function redactPath(pathname: string): string {
    const segments = pathname.split('/');
    let maskNext = 0;
    let prefixSeen = false;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg === '') continue;
        if (maskNext > 0) {
            segments[i] = MASK;
            maskNext--;
            continue;
        }
        if (!prefixSeen && XTREAM_PATH_PREFIXES.has(seg.toLowerCase())) {
            prefixSeen = true;
            maskNext = 2;
            continue;
        }
        if (isOpaqueToken(seg)) segments[i] = MASK;
    }
    return segments.join('/');
}

function redactQuery(search: string): string {
    if (search === '' || search === '?') return '';
    const pairs = search.slice(1).split('&');
    const out = pairs.map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return isOpaqueToken(pair) ? MASK : pair;
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value === '') return pair;
        if (isSecretQueryKey(key) || isOpaqueToken(value)) return `${key}=${MASK}`;
        return pair;
    });
    return `?${out.join('&')}`;
}

/**
 * Redact one Live TV URL for logs, stored error messages and non-admin responses.
 *
 * `http://u:p@host:8080/playlist/u/p/m3u_plus?username=u&password=p&type=m3u_plus`
 * keeps `http://`, `host:8080`, `/playlist/`, `/m3u_plus` and `type=m3u_plus`; the
 * userinfo, both path credentials and both credential values become `***`.
 *
 * Never throws. Input that does not parse as an absolute URL cannot be reasoned
 * about structurally, so it is replaced wholesale rather than echoed.
 */
export function redactLiveTvUrl(url: string): string {
    if (typeof url !== 'string' || url === '') return '';
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return '<unparseable url>';
    }
    // Non-hierarchical schemes (`data:`, `mailto:`) have no host to keep — and a
    // `data:` URL can be arbitrarily large — so they collapse to the scheme.
    if (!parsed.host) return `${parsed.protocol}<redacted>`;

    const userinfo = parsed.username || parsed.password ? `${MASK}@` : '';
    const hash = parsed.hash ? `#${MASK}` : '';
    return (
        `${parsed.protocol}//${userinfo}${parsed.host}` +
        `${redactPath(parsed.pathname)}${redactQuery(parsed.search)}${hash}`
    );
}

/**
 * `scheme://…` up to whitespace, a quote, an angle bracket or a backslash.
 *
 * The backslash stop matters for JSON-serialized input: a URL followed by `\n` or
 * `\"` must not swallow the escape, because WHATWG URL parsing turns `\` into `/`
 * and would corrupt (or unterminate) the surrounding JSON string.
 */
const URL_IN_TEXT_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>`\\]+/g;

/** Punctuation that ends a sentence rather than the URL (`… from http://x/y.`). */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;

/** A bare Xtream path with no scheme in front (e.g. an upstream error echoing only
 *  the request path). */
const BARE_XTREAM_PATH_RE =
    /\/(playlist|epg|live|movie|series|timeshift)\/[^/\s'"?#&\\]+(?:\/[^/\s'"?#&\\]+)?/gi;

/** A bare `key=value` query fragment outside a full URL. Both bare patterns stop at
 *  `\` for the same JSON-escape reason as {@link URL_IN_TEXT_RE}. */
const BARE_SECRET_PARAM_RE =
    /\b(username|user|password|pass|passwd|pwd|token|auth|api_key|apikey|stream_token|access_token)=([^&\s'"<>\\]+)/gi;

/**
 * Redact every URL inside free text — an error message, a stored summary, a
 * stderr tail — plus bare Xtream paths and bare credential `key=value` pairs.
 *
 * Idempotent: running it twice yields the same string.
 */
export function redactLiveTvUrlsInText(text: string): string {
    if (typeof text !== 'string' || text === '') return text;
    const withUrls = text.replace(URL_IN_TEXT_RE, (match) => {
        const trail = TRAILING_PUNCT_RE.exec(match)?.[0] ?? '';
        const core = trail ? match.slice(0, -trail.length) : match;
        return redactLiveTvUrl(core) + trail;
    });
    return withUrls
        .replace(BARE_XTREAM_PATH_RE, (m, prefix: string) => {
            const masked = m.split('/').length - 2; // segments after the prefix
            return `/${prefix}/${masked >= 2 ? `${MASK}/${MASK}` : MASK}`;
        })
        .replace(BARE_SECRET_PARAM_RE, (_m, key: string) => `${key}=${MASK}`);
}
