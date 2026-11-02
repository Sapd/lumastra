// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { isTmdbBearerToken, tmdbAuthorizedRequest } from './auth.js';

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

describe('isTmdbBearerToken', () => {
    it('recognises a v4 Read Access Token by its JWT prefix', () => {
        expect(isTmdbBearerToken(V4_TOKEN)).toBe(true);
        expect(isTmdbBearerToken(`  ${V4_TOKEN}\n`)).toBe(true);
    });

    it('treats a v3 API key as not a Bearer token', () => {
        expect(isTmdbBearerToken(V3_KEY)).toBe(false);
    });
});

describe('tmdbAuthorizedRequest', () => {
    it('puts a v3 key in ?api_key= and sends no Authorization header', () => {
        const { url, headers } = tmdbAuthorizedRequest(
            'https://api.themoviedb.org/3/search/person?query=Ada%20Lovelace&page=1',
            V3_KEY,
            { 'Content-Type': 'application/json' },
        );
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/3/search/person');
        expect(parsed.searchParams.get('query')).toBe('Ada Lovelace');
        expect(parsed.searchParams.get('page')).toBe('1');
        expect(parsed.searchParams.get('api_key')).toBe(V3_KEY);
        expect(headers).toEqual({ 'Content-Type': 'application/json' });
    });

    it('sends a v4 token as Bearer and leaves the URL unchanged', () => {
        const input = 'https://api.themoviedb.org/3/person/42?language=en-US';
        const { url, headers } = tmdbAuthorizedRequest(input, V4_TOKEN, {
            'Content-Type': 'application/json',
        });
        expect(url).toBe(input);
        expect(new URL(url).searchParams.has('api_key')).toBe(false);
        expect(headers).toEqual({
            'Content-Type': 'application/json',
            Authorization: `Bearer ${V4_TOKEN}`,
        });
    });

    it('trims surrounding whitespace from the configured key', () => {
        expect(
            new URL(
                tmdbAuthorizedRequest('https://x.test/3/a', ` ${V3_KEY} `).url,
            ).searchParams.get('api_key'),
        ).toBe(V3_KEY);
        expect(
            tmdbAuthorizedRequest('https://x.test/3/a', `${V4_TOKEN}\n`).headers.Authorization,
        ).toBe(`Bearer ${V4_TOKEN}`);
    });

    it('does not let a caller header override the auth header', () => {
        const { headers } = tmdbAuthorizedRequest('https://x.test/3/a', V4_TOKEN, {
            Authorization: 'Bearer something-else',
        });
        expect(headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    });

    it('does not mutate a URL object passed in', () => {
        const input = new URL('https://api.themoviedb.org/3/movie/popular?page=2');
        tmdbAuthorizedRequest(input, V3_KEY);
        expect(input.searchParams.has('api_key')).toBe(false);
    });
});
