// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turn Node's opaque `TypeError: fetch failed` into something an operator can act
 * on. undici puts the real reason on `error.cause` (sometimes nested, sometimes an
 * AggregateError of per-address attempts): `SELF_SIGNED_CERT_IN_CHAIN`,
 * `ENOTFOUND`, `ECONNREFUSED`, … The Linux e2e (2026-09-29) showed only
 * "OIDC discovery failed: TypeError: fetch failed" for a Dex behind a private CA.
 *
 * The output names an error CODE and the cause's own message (host / address as
 * the resolver reported it) — no request data, headers or secrets. Callers decide
 * which surfaces may show it (admin / pre-admin setup only).
 */

import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import * as m from '$lib/paraglide/messages';

/** TLS trust failures: the fix is always "make Node trust the provider's CA". */
const TLS_TRUST_CODES = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_UNTRUSTED',
]);

const CERT_EXPIRED_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);
const HTTPS_PROTOCOL_CODES = new Set([
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_PACKET_LENGTH_TOO_LONG',
]);

const MAX_DEPTH = 5;

interface CauseInfo {
    code: string | null;
    message: string | null;
}

function readCode(value: unknown): string | null {
    if (value === null || typeof value !== 'object') return null;
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
}

function readMessage(value: unknown): string | null {
    if (value instanceof Error && value.message) return value.message;
    return null;
}

/** The deepest cause carrying a `code` (falling back to the deepest message). */
function findRootCause(error: unknown): CauseInfo {
    let best: CauseInfo = { code: null, message: null };
    const visit = (value: unknown, depth: number): void => {
        if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
        const code = readCode(value);
        const message = readMessage(value);
        if (depth > 0 && (code || (!best.code && message))) {
            best = { code: code ?? best.code, message: message ?? best.message };
        }
        // AggregateError (happy-eyeballs: one error per address) — first one wins.
        const errors = (value as { errors?: unknown }).errors;
        if (Array.isArray(errors) && errors.length > 0) visit(errors[0], depth + 1);
        visit((value as { cause?: unknown }).cause, depth + 1);
    };
    visit(error, 0);
    return best;
}

export function classifyFetchFailure(error: unknown): 'tls' | 'unreachable' | 'unknown' {
    const code = findRootCause(error).code ?? readCode(error);
    if (
        code &&
        (TLS_TRUST_CODES.has(code) ||
            CERT_EXPIRED_CODES.has(code) ||
            code.startsWith('ERR_TLS_') ||
            code.startsWith('ERR_SSL_'))
    )
        return 'tls';
    if (
        code &&
        [
            'ENOTFOUND',
            'EAI_AGAIN',
            'ECONNREFUSED',
            'ECONNRESET',
            'EHOSTUNREACH',
            'ENETUNREACH',
            'ETIMEDOUT',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_SOCKET',
            'OAUTH_TIMEOUT',
            'OAUTH_ABORT',
        ].includes(code)
    )
        return 'unreachable';
    if (
        error instanceof TypeError ||
        (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    ) {
        return 'unreachable';
    }
    return 'unknown';
}

/** A one-line remediation for the codes an operator can fix from config. */
export function fetchFailureHint(code: string | null): string | null {
    if (!code) return null;
    if (HTTPS_PROTOCOL_CODES.has(code)) return m.setup_connection_https_hint();
    if (TLS_TRUST_CODES.has(code)) {
        return "The provider's certificate isn't trusted — set NODE_EXTRA_CA_CERTS to its CA file (readable by the app user) and restart.";
    }
    if (CERT_EXPIRED_CODES.has(code)) {
        return "The provider's certificate is expired or not yet valid — renew it (or check the server clock).";
    }
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        return "The provider's certificate doesn't cover this hostname — check the issuer URL matches the certificate.";
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return 'The hostname does not resolve from the app container — check the URL and the container’s DNS.';
    }
    if (code === 'ECONNREFUSED') {
        return 'Nothing is listening at that address and port as seen from the app container.';
    }
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
        return 'The connection timed out — check firewalls and that the app container can reach the provider.';
    }
    return null;
}

/**
 * Describe a failed outbound fetch: `fetch failed (SELF_SIGNED_CERT_IN_CHAIN:
 * self-signed certificate in certificate chain). <hint>`. Errors without a
 * nested cause retain their original wording. URL credentials and supplied
 * secret values are redacted on both paths.
 */
export function describeFetchFailure(error: unknown, secrets: readonly string[] = []): string {
    const top = error instanceof Error ? error.message || String(error) : String(error);
    const cause = findRootCause(error);
    let description = String(error);
    if (cause.code || cause.message) {
        const parts = [
            cause.code,
            cause.message && cause.message !== cause.code ? cause.message : null,
        ]
            .filter((part): part is string => Boolean(part))
            .join(': ');
        const hint = fetchFailureHint(cause.code);
        description = `${top} (${parts})${hint ? `. ${hint}` : ''}`;
    }
    return scrubConnectionText(description, secrets);
}

type ConnectionFailureKind =
    | 'refused'
    | 'dns'
    | 'timeout'
    | 'reset'
    | 'unreachable'
    | 'invalid_url'
    | 'tls_trust'
    | 'tls_expired'
    | 'tls_hostname'
    | 'https_protocol'
    | 'redirect'
    | 'unknown';

function connectionFailureKind(error: unknown, depth = 0): ConnectionFailureKind {
    if (depth > MAX_DEPTH || error === null || typeof error !== 'object') return 'unknown';
    const { code, name, cause, errors, message } = error as Record<string, unknown>;
    if (name === 'TimeoutError' || name === 'AbortError' || name === 'FetchTimeoutError')
        return 'timeout';
    if (name === 'FetchRedirectError') return 'redirect';
    if (typeof code === 'string') {
        if (code === 'ECONNREFUSED') return 'refused';
        if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return 'dns';
        if (/^(ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(code)) return 'timeout';
        if (/^(ECONNRESET|UND_ERR_SOCKET)$/.test(code)) return 'reset';
        if (/^(EHOSTUNREACH|ENETUNREACH)$/.test(code)) return 'unreachable';
        if (code === 'ERR_INVALID_URL') return 'invalid_url';
        if (HTTPS_PROTOCOL_CODES.has(code)) return 'https_protocol';
        // OpenSSL reports an HTTPS client talking to a plain-http port as EPROTO too.
        if (
            code === 'EPROTO' &&
            typeof message === 'string' &&
            /wrong version number/i.test(message)
        )
            return 'https_protocol';
        if (TLS_TRUST_CODES.has(code)) return 'tls_trust';
        if (CERT_EXPIRED_CODES.has(code)) return 'tls_expired';
        if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls_hostname';
    }
    const nested = connectionFailureKind(cause, depth + 1);
    if (nested !== 'unknown') return nested;
    if (Array.isArray(errors)) {
        for (const entry of errors.slice(0, 8)) {
            const kind = connectionFailureKind(entry, depth + 1);
            if (kind !== 'unknown') return kind;
        }
    }
    return 'unknown';
}

export function connectionFailureHint(error: unknown, url: string): string {
    const kind = connectionFailureKind(error);
    if (kind === 'tls_trust') return m.setup_connection_tls_hint();
    if (kind === 'tls_expired') return m.setup_connection_expired_hint();
    if (kind === 'tls_hostname') return m.setup_connection_hostname_hint();
    if (kind === 'https_protocol') return m.setup_connection_https_hint();
    if (kind === 'redirect') return m.setup_connection_redirect_hint();
    if (kind === 'refused') {
        try {
            const host = new URL(url).hostname;
            if (host === 'localhost' || host.startsWith('127.') || host === '[::1]') {
                return m.setup_connection_localhost_hint();
            }
        } catch {
            return '';
        }
    }
    return '';
}

export function connectionFailureCause(error: unknown): string {
    const causes: Record<ConnectionFailureKind, () => string> = {
        refused: m.setup_connection_refused,
        dns: m.setup_connection_dns,
        timeout: m.setup_connection_timeout,
        reset: m.setup_connection_reset,
        unreachable: m.setup_connection_unreachable,
        invalid_url: m.setup_connection_invalid_url,
        tls_trust: m.setup_connection_tls,
        tls_expired: m.setup_connection_tls,
        tls_hostname: m.setup_connection_tls,
        https_protocol: m.setup_connection_https_protocol,
        redirect: m.setup_connection_redirect,
        unknown: m.setup_connection_unknown,
    };
    return causes[connectionFailureKind(error)]();
}

export function describeSetupFetchFailure(
    error: unknown,
    url: string,
    secrets: readonly string[] = [],
): string {
    if (urlHasUserinfo(url)) return m.setup_connection_url_credentials();
    let address: string = m.setup_connection_address();
    try {
        const parsed = new URL(url);
        if (
            ['http:', 'https:'].includes(parsed.protocol) &&
            !secrets.some((secret) => secret && parsed.origin.includes(secret))
        ) {
            address = parsed.origin;
        }
    } catch {
        address = m.setup_connection_address();
    }
    return [
        m.setup_connection_failed({ address, cause: connectionFailureCause(error) }),
        connectionFailureHint(error, url),
    ]
        .filter(Boolean)
        .join(' ');
}

export function setupProbeHttpError(
    status: number,
    context: 'general' | 'embedding' = 'general',
): string {
    if (status === 401 || status === 403) return m.setup_probe_auth_error({ status });
    if (status === 400 || status === 404 || status === 422)
        return context === 'embedding'
            ? m.setup_embedding_probe_request_error({ status })
            : m.setup_probe_request_error({ status });
    if (status === 429) return m.setup_probe_rate_error();
    return m.setup_probe_http_error({ status });
}

/** True when the URL carries a user name or password before the host. */
export function urlHasUserinfo(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.username !== '' || parsed.password !== '';
    } catch {
        return false;
    }
}

/** Every `scheme://…` run in free text (stops at whitespace, quotes, brackets, backslash). */
const URL_IN_TEXT_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>`\\]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/;

/**
 * Scrub free text before it reaches a UI message, an API body or a log line.
 * Every URL keeps its scheme, host and path, and loses its user:password, query
 * string and hash, so a key in `?api_key=` or `user:pass@` cannot survive. Bare
 * Xtream and `key=value` credentials are masked too, and each supplied secret
 * (plus its URL-encoded form) becomes `[redacted]`. Never throws.
 */
export function scrubConnectionText(text: string, secrets: readonly string[] = []): string {
    if (typeof text !== 'string' || text === '') return text;
    let out = text.replace(URL_IN_TEXT_RE, (match) => {
        const trail = TRAILING_PUNCT_RE.exec(match)?.[0] ?? '';
        const core = trail ? match.slice(0, -trail.length) : match;
        try {
            const parsed = new URL(core);
            const path = parsed.pathname === '/' ? '' : parsed.pathname;
            return `${parsed.protocol}//${parsed.host}${path}${trail}`;
        } catch {
            return `[url]${trail}`;
        }
    });
    out = redactLiveTvUrlsInText(out);
    for (const secret of secrets) {
        if (!secret) continue;
        out = out
            .replaceAll(secret, '[redacted]')
            .replaceAll(encodeURIComponent(secret), '[redacted]');
    }
    return out;
}

/**
 * The one message a connection test (Settings or wizard) shows for a thrown error.
 * Network, TLS and `fetch failed` errors take the wizard wording
 * ({@link describeSetupFetchFailure}); anything else is scrubbed text. A URL with
 * user:password always gets the credential sentence, whatever the error says.
 */
export function describeConnectionTestError(
    error: unknown,
    url: string,
    secrets: readonly string[] = [],
): string {
    if (urlHasUserinfo(url)) return m.setup_connection_url_credentials();
    const text = error instanceof Error ? error.message : String(error);
    const code = findRootCause(error).code ?? readCode(error);
    if (classifyFetchFailure(error) !== 'unknown' || code || /^fetch failed\b/i.test(text)) {
        return describeSetupFetchFailure(error, url, secrets);
    }
    return scrubConnectionText(text || 'Unknown error', secrets);
}
