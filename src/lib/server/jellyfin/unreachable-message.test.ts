// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeJellyfinUnreachable } from './unreachable-message.js';

const localeState = vi.hoisted(() => ({ current: 'en' }));
vi.mock('$lib/paraglide/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/paraglide/runtime')>()),
    getLocale: () => localeState.current,
}));

const TAIL = 'Check the address and that Jellyfin is running.';

/** Mirrors what undici puts on a failed fetch: a generic message plus a `cause`. */
function fetchFailed(code: string, causeMessage = ''): TypeError {
    return new TypeError('fetch failed', {
        cause: Object.assign(new Error(causeMessage || code), { code }),
    });
}

describe('describeJellyfinUnreachable', () => {
    beforeEach(() => {
        localeState.current = 'en';
    });
    it('localizes the whole German DNS, HTTPS and credential errors', () => {
        localeState.current = 'de';
        const dns = describeJellyfinUnreachable('http://jf:8096', fetchFailed('ENOTFOUND'));
        expect(dns).toBe(
            'Jellyfin ist unter http://jf:8096 nicht erreichbar (Hostname nicht gefunden). Prüfe die Adresse und ob Jellyfin läuft.',
        );
        const https = describeJellyfinUnreachable(
            'https://jf:8096',
            fetchFailed('ERR_SSL_WRONG_VERSION_NUMBER'),
        );
        expect(https).toContain('HTTPS-Protokollfehler');
        expect(https.match(/versuche http:\/\//g)).toHaveLength(1);
        expect(https).not.toMatch(/Could not|Check the|try http/);
        const credentials = describeJellyfinUnreachable(
            'http://u:secret@jf:8096',
            new TypeError('fetch failed'),
        );
        expect(credentials).toBe(
            'Entferne Benutzername und Passwort aus der Adresse; Jellyfin verbindet sich nur mit dem API-Schlüssel.',
        );
        expect(credentials).not.toContain('secret');
    });
    it.each(['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG'])(
        'does not call %s a certificate error',
        (code) => {
            const message = describeJellyfinUnreachable('https://jf:8096', fetchFailed(code));
            expect(message).toMatch(/does not speak HTTPS.*try http:\/\//i);
            expect(message).not.toMatch(/certificate|NODE_EXTRA_CA_CERTS/i);
        },
    );
    it('explains how to trust a private CA or use http on the local network', () => {
        const message = describeJellyfinUnreachable(
            'https://jf.lan',
            fetchFailed('SELF_SIGNED_CERT_IN_CHAIN'),
        );
        expect(message).toContain('NODE_EXTRA_CA_CERTS');
        expect(message).toMatch(/http.*network/i);
    });

    it.each(['localhost', '127.0.0.1', '[::1]'])('explains container loopback for %s', (host) => {
        const message = describeJellyfinUnreachable(
            `http://${host}:8096`,
            fetchFailed('ECONNREFUSED'),
        );
        expect(message).toMatch(/container itself/i);
        expect(message).toMatch(/host.*address|service name/i);
    });
    it('names the URL tried and the plain-words cause for connection refused', () => {
        expect(
            describeJellyfinUnreachable('http://jellyfin:8096', fetchFailed('ECONNREFUSED')),
        ).toBe(
            'Could not reach Jellyfin at http://jellyfin:8096 (connection refused). Check the address and that Jellyfin is running.',
        );
    });

    it('explains an unknown host name', () => {
        expect(
            describeJellyfinUnreachable('http://jellyfn.local:8096', fetchFailed('ENOTFOUND')),
        ).toContain('(host name not found)');
        expect(
            describeJellyfinUnreachable('http://jellyfn.local:8096', fetchFailed('EAI_AGAIN')),
        ).toContain('(host name not found)');
    });

    it('explains a timeout, from either a connect timeout or an abort timeout', () => {
        expect(
            describeJellyfinUnreachable('http://jf:8096', fetchFailed('UND_ERR_CONNECT_TIMEOUT')),
        ).toContain('(timed out)');
        const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
        });
        expect(describeJellyfinUnreachable('http://jf:8096', timeout)).toContain('(timed out)');
    });

    it('explains a TLS certificate problem', () => {
        expect(
            describeJellyfinUnreachable(
                'https://jf.example.com',
                fetchFailed('DEPTH_ZERO_SELF_SIGNED_CERT'),
            ),
        ).toContain('(TLS certificate error)');
        expect(
            describeJellyfinUnreachable(
                'https://jf.example.com',
                fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID'),
            ),
        ).toContain('(TLS certificate error)');
    });

    it('names the other network causes in plain words', () => {
        expect(
            describeJellyfinUnreachable('http://jf:8096', fetchFailed('EHOSTUNREACH')),
        ).toContain('(host or network unreachable)');
        expect(describeJellyfinUnreachable('http://jf:8096', fetchFailed('ECONNRESET'))).toContain(
            '(connection was reset)',
        );
    });

    it('says "connection failed" for an unknown error and never echoes its text', () => {
        expect(
            describeJellyfinUnreachable('http://jf:8096', new Error('socket hung up: secret-ish')),
        ).toBe(`Could not reach Jellyfin at http://jf:8096 (connection failed). ${TAIL}`);
        expect(describeJellyfinUnreachable('http://jf:8096', new TypeError('fetch failed'))).toBe(
            `Could not reach Jellyfin at http://jf:8096 (connection failed). ${TAIL}`,
        );
    });

    it('never shows the query string or fragment of the URL', () => {
        const message = describeJellyfinUnreachable(
            'http://jellyfin.lan:8096/jf/?api_key=SECRET-KEY#frag',
            fetchFailed('ECONNREFUSED'),
        );
        expect(message).toContain('at http://jellyfin.lan:8096/jf (connection refused)');
        expect(message).not.toContain('hunter2');
        expect(message).not.toContain('SECRET-KEY');
        expect(message).not.toContain('api_key');
        expect(message).not.toContain('frag');
    });

    it('does not echo a URL with userinfo from a fetch TypeError that quotes it', () => {
        const message = describeJellyfinUnreachable(
            'http://u:p4ss@host/x?x=1',
            new TypeError(
                'Request cannot be constructed with a URL that includes credentials: http://u:p4ss@host/x?x=1',
            ),
        );
        expect(message).toBe(
            'Remove the user name and password from the address; Jellyfin connects with the API key only.',
        );
        expect(message).not.toContain('p4ss');
        expect(message).not.toContain('host');
        expect(message).not.toContain('x=1');
    });

    it('does not echo an api_key query from a "Failed to parse URL" message', () => {
        const message = describeJellyfinUnreachable(
            'http://jf:8096/?api_key=SECRET-KEY',
            new TypeError('Failed to parse URL from http://jf:8096/?api_key=SECRET-KEY'),
        );
        expect(message).toBe(
            `Could not reach Jellyfin at http://jf:8096 (connection failed). ${TAIL}`,
        );
        expect(message).not.toContain('SECRET-KEY');
        expect(message).not.toContain('api_key');
    });

    it('does not echo a percent-encoded key from the URL or the error', () => {
        const message = describeJellyfinUnreachable(
            'http://jf:8096/Users?api_key=ab%2Bc%3D%3D',
            new TypeError('Failed to parse URL from http://jf:8096/Users?api_key=ab%2Bc%3D%3D'),
        );
        expect(message).not.toContain('ab%2Bc');
        expect(message).not.toContain('%3D');
        expect(message).not.toContain('api_key');
    });

    it('drops a path that carries the API key, keeping the origin', () => {
        const message = describeJellyfinUnreachable(
            'http://jf:8096/emby/SECRET-KEY',
            fetchFailed('ECONNREFUSED'),
            ['SECRET-KEY'],
        );
        expect(message).toBe(
            `Could not reach Jellyfin at http://jf:8096 (connection refused). ${TAIL}`,
        );
    });

    it('never echoes the API key from an error message', () => {
        const message = describeJellyfinUnreachable(
            'http://jf:8096',
            new Error('Token "abc-API-KEY-123" rejected'),
            ['abc-API-KEY-123'],
        );
        expect(message).not.toContain('abc-API-KEY-123');
        expect(message).toBe(
            `Could not reach Jellyfin at http://jf:8096 (connection failed). ${TAIL}`,
        );
    });

    it('says the address is not a valid URL when the URL cannot be parsed, without echoing it', () => {
        const message = describeJellyfinUnreachable(
            'http://u:p4ss@[bad',
            new TypeError('Failed to parse URL from http://u:p4ss@[bad'),
        );
        expect(message).toBe(
            `Could not reach Jellyfin at the configured server (the address is not a valid URL). ${TAIL}`,
        );
        expect(message).not.toContain('p4ss');
    });

    it('still produces a readable sentence when the URL cannot be parsed', () => {
        expect(describeJellyfinUnreachable('not a url', fetchFailed('ECONNREFUSED'))).toBe(
            `Could not reach Jellyfin at the configured server (the address is not a valid URL). ${TAIL}`,
        );
    });

    it('explains a key with characters a header cannot carry, without echoing it', () => {
        const message = describeJellyfinUnreachable(
            'http://jellyfin.lan:8096',
            new Error('Invalid Jellyfin token'),
            ['bad\nkey'],
        );
        expect(message).toContain('The API key contains characters that are not allowed');
        expect(message).not.toContain('bad');
    });

    it('explains an ERR_INVALID_URL code as an invalid address', () => {
        expect(
            describeJellyfinUnreachable('http://jf:8096', fetchFailed('ERR_INVALID_URL')),
        ).toContain('(the address is not a valid URL)');
    });
});
