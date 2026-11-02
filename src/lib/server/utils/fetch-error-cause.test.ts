// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
    classifyFetchFailure,
    describeFetchFailure,
    fetchFailureHint,
    describeSetupFetchFailure,
    scrubConnectionText,
    setupProbeHttpError,
} from './fetch-error-cause.js';

const localeState = vi.hoisted(() => ({ current: 'en' }));
vi.mock('$lib/paraglide/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/paraglide/runtime')>()),
    getLocale: () => localeState.current,
}));
afterEach(() => {
    localeState.current = 'en';
});

function coded(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

/** The shape undici throws: TypeError('fetch failed', { cause }). */
function fetchFailed(cause: unknown): TypeError {
    return new TypeError('fetch failed', { cause });
}

describe('describeFetchFailure', () => {
    it('names a self-signed chain and says how to trust the CA', () => {
        const out = describeFetchFailure(
            fetchFailed(
                coded('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'),
            ),
        );
        expect(out).toBe(
            "fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain). The provider's certificate isn't trusted — set NODE_EXTRA_CA_CERTS to its CA file (readable by the app user) and restart.",
        );
    });

    it('covers UNABLE_TO_VERIFY_LEAF_SIGNATURE with the same TLS hint', () => {
        const out = describeFetchFailure(
            fetchFailed(
                coded('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
            ),
        );
        expect(out).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
        expect(out).toContain('NODE_EXTRA_CA_CERTS');
    });

    it('names an expired certificate', () => {
        const out = describeFetchFailure(
            fetchFailed(coded('certificate has expired', 'CERT_HAS_EXPIRED')),
        );
        expect(out).toContain('CERT_HAS_EXPIRED: certificate has expired');
        expect(out).toMatch(/expired or not yet valid/);
    });

    it('names DNS and refused-connection failures', () => {
        expect(
            describeFetchFailure(
                fetchFailed(coded('getaddrinfo ENOTFOUND dex.local', 'ENOTFOUND')),
            ),
        ).toContain('ENOTFOUND: getaddrinfo ENOTFOUND dex.local');
        expect(
            describeFetchFailure(
                fetchFailed(coded('connect ECONNREFUSED 10.0.0.2:5556', 'ECONNREFUSED')),
            ),
        ).toMatch(/ECONNREFUSED.*Nothing is listening/);
    });

    it('digs through an AggregateError of per-address attempts', () => {
        const agg = Object.assign(
            new AggregateError([coded('connect ECONNREFUSED ::1:5556', 'ECONNREFUSED')], ''),
            { code: 'ECONNREFUSED' },
        );
        expect(describeFetchFailure(fetchFailed(agg))).toContain('ECONNREFUSED');
    });

    it('finds a cause nested under a wrapping library error', () => {
        const wrapped = new Error('something went wrong', {
            cause: fetchFailed(coded('certificate has expired', 'CERT_HAS_EXPIRED')),
        });
        expect(describeFetchFailure(wrapped)).toContain('CERT_HAS_EXPIRED');
    });

    it('leaves an error without a cause unchanged', () => {
        expect(describeFetchFailure(new Error('unexpected HTTP status 404'))).toBe(
            'Error: unexpected HTTP status 404',
        );
        expect(describeFetchFailure('plain string')).toBe('plain string');
    });

    it('redacts URL credentials and keys throughout the cause chain', () => {
        const original = new TypeError('https://alice:pass123@idp.example/?api_key=top-secret', {
            cause: coded(
                'connect https://bob:pass456@idp.example/?client_secret=cause-secret&key=private-key',
                'ECONNREFUSED',
            ),
        });
        const result = describeFetchFailure(original);
        expect(result).toContain('ECONNREFUSED');
        expect(result).toContain('idp.example');
        for (const secret of [
            'alice',
            'bob',
            'pass123',
            'pass456',
            'top-secret',
            'cause-secret',
            'private-key',
        ]) {
            expect(result).not.toContain(secret);
        }
    });

    it('redacts known client secrets, including their URL-encoded form', () => {
        const secret = 'client/secret!';
        const result = describeFetchFailure(
            new Error(`${secret} and ${encodeURIComponent(secret)}`),
            [secret],
        );
        expect(result).not.toContain(secret);
        expect(result).not.toContain(encodeURIComponent(secret));
    });
});

describe('fetchFailureHint', () => {
    it('has no hint for an unknown code', () => {
        expect(fetchFailureHint('EWHATEVER')).toBeNull();
        expect(fetchFailureHint(null)).toBeNull();
    });
});

describe('classifyFetchFailure', () => {
    it.each(['OAUTH_TIMEOUT', 'OAUTH_ABORT'])(
        'recognizes the discovery library cancellation code %s',
        (code) => {
            const failure = coded('operation did not complete', code);
            expect(classifyFetchFailure(failure)).toBe('unreachable');
        },
    );
});

describe('safe setup failure classification', () => {
    it.each(['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG'])(
        'explains plain HTTP behind an HTTPS address for %s',
        (code) => {
            const message = describeSetupFetchFailure(
                fetchFailed(coded('secret-token', code)),
                'https://host:8000',
            );
            expect(message).toMatch(/does not speak HTTPS.*try http:\/\//i);
            expect(message).not.toMatch(/certificate|NODE_EXTRA_CA_CERTS|secret-token/i);
        },
    );

    it.each([
        ['en', 'HTTPS protocol mismatch', 'try http://'],
        ['de', 'HTTPS-Protokollfehler', 'versuche http://'],
    ])('pairs the shortened HTTPS cause with one actionable hint in %s', (locale, cause, hint) => {
        localeState.current = locale;
        const message = describeSetupFetchFailure(
            fetchFailed(coded('secret-token', 'ERR_SSL_WRONG_VERSION_NUMBER')),
            'https://host:8096',
        );
        expect(message).toContain(cause);
        expect(message.split(hint)).toHaveLength(2);
        if (locale === 'de') expect(message).not.toMatch(/HTTPS protocol mismatch|try http/);
        else expect(message).not.toMatch(/HTTPS-Protokollfehler|versuche http/);
    });

    it.each(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'])(
        'gives a certificate validity remedy for %s',
        (code) => {
            const message = describeSetupFetchFailure(
                fetchFailed(coded('secret-token', code)),
                'https://host',
            );
            expect(message).toMatch(/renew|server clock/i);
            expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
        },
    );

    it('gives a hostname remedy rather than a trust remedy for hostname mismatch', () => {
        const message = describeSetupFetchFailure(
            fetchFailed(coded('secret-token', 'ERR_TLS_CERT_ALTNAME_INVALID')),
            'https://host',
        );
        expect(message).toMatch(/hostname.*match|match.*hostname/i);
        expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
    });

    it.each([
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ])('gives the CA remedy for the explicit trust code %s', (code) => {
        expect(
            describeSetupFetchFailure(fetchFailed(coded('secret-token', code)), 'https://host'),
        ).toContain('NODE_EXTRA_CA_CERTS');
    });

    it('does not guess certificate errors from arbitrary SSL-like codes', () => {
        const message = describeSetupFetchFailure(
            fetchFailed(coded('secret-token', 'ERR_SSL_SECRET')),
            'https://host',
        );
        expect(message).toContain('(connection failed)');
        expect(message).not.toMatch(/certificate|NODE_EXTRA_CA_CERTS|secret-token|ERR_SSL_SECRET/i);
    });

    it('explains refused redirects without echoing the redirect address', () => {
        const error = Object.assign(new Error('https://user:password@private/secret-token'), {
            name: 'FetchRedirectError',
        });
        const message = describeSetupFetchFailure(error, 'https://host');
        expect(message).toMatch(/redirect.*refused|refused.*redirect/i);
        expect(message).not.toMatch(/password|private|secret-token/);
    });

    it.each([400, 404, 422])('uses generic request advice for non-embedding HTTP %s', (status) => {
        const message = setupProbeHttpError(status);
        expect(message).toMatch(/address.*settings/i);
        expect(message).not.toMatch(/embedding|model|dimension/i);
    });
});

describe('connection-test redaction (F1, F2)', () => {
    it('describeSetupFetchFailure gives the credential sentence for a URL with userinfo', () => {
        const url = 'http://u:p4ss@host:8000/x';
        const message = describeSetupFetchFailure(
            new TypeError(
                `Request cannot be constructed from a URL that includes credentials: ${url}`,
            ),
            url,
        );
        expect(message).toBe(
            'Remove the user name and password from the address; this connection uses the API key only.',
        );
        expect(message).not.toContain('p4ss');
    });

    it('maps EPROTO "wrong version number" to the HTTPS mismatch guidance', () => {
        const message = describeSetupFetchFailure(
            fetchFailed(coded('wrong version number', 'EPROTO')),
            'https://host:8096',
        );
        expect(message).toContain('HTTPS protocol mismatch');
        expect(message).toContain('try http://');
    });

    it('scrubConnectionText keeps the origin and path, and drops userinfo, query and hash', () => {
        expect(scrubConnectionText('Failed https://u:p@h:8096/a/b?x=1&api_key=K#frag', ['K'])).toBe(
            'Failed https://h:8096/a/b',
        );
    });

    it('scrubConnectionText masks a secret that sits in the path', () => {
        expect(scrubConnectionText('GET https://h/emby/KEY123/x', ['KEY123'])).toBe(
            'GET https://h/emby/[redacted]/x',
        );
    });

    it('describeFetchFailure drops the query string of any URL it echoes', () => {
        const out = describeFetchFailure(
            new Error('fetch failed for https://host/x?page=2&sort=asc'),
        );
        expect(out).toContain('https://host/x');
        expect(out).not.toContain('page=2');
        expect(out).not.toContain('sort=asc');
    });
});
