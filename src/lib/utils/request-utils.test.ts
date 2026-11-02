// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for Request Validation Utilities
 */

import { describe, test, expect } from 'vitest';
import { canRequestMedia, getRequestFailureMessage } from './request-utils';
import type { ExternalIds } from '$lib/types/api-common';

describe('canRequestMedia', () => {
    describe('with request modal enabled', () => {
        test('allows TMDB ID', () => {
            const externalIds: ExternalIds = { tmdb: '550' };
            const result = canRequestMedia(externalIds, true, '');

            expect(result).toEqual({ canRequest: true });
        });

        test('allows IMDB ID (server resolves)', () => {
            const externalIds: ExternalIds = { imdb: 'tt0137523' };
            const result = canRequestMedia(externalIds, true, '');

            expect(result).toEqual({ canRequest: true });
        });

        test('allows TVDB ID (server resolves)', () => {
            const externalIds: ExternalIds = { tvdb: '12345' };
            const result = canRequestMedia(externalIds, true, '');

            expect(result).toEqual({ canRequest: true });
        });

        test('blocks an internal UUID alone (no provider id to request by)', () => {
            const externalIds: ExternalIds = {
                internal: '550e8400-e29b-41d4-a716-446655440000',
            };
            const result = canRequestMedia(externalIds, true, '');

            expect(result).toEqual({ canRequest: false, reason: 'no_external_ids' });
        });

        test('allows multiple IDs (any valid ID works)', () => {
            const externalIds: ExternalIds = {
                tmdb: '550',
                imdb: 'tt0137523',
                internal: '550e8400-e29b-41d4-a716-446655440000',
            };
            const result = canRequestMedia(externalIds, true, '');

            expect(result).toEqual({ canRequest: true });
        });

        test('blocks empty externalIds', () => {
            const result = canRequestMedia({}, true, '');

            expect(result).toEqual({
                canRequest: false,
                reason: 'no_external_ids',
            });
        });

        test('blocks undefined externalIds', () => {
            const result = canRequestMedia(undefined, true, '');

            expect(result).toEqual({
                canRequest: false,
                reason: 'no_external_ids',
            });
        });
    });

    describe('with request modal disabled (external URL)', () => {
        const requestUrl = 'https://jellyseerr.example.com';

        test('allows TMDB ID', () => {
            const externalIds: ExternalIds = { tmdb: '550' };
            const result = canRequestMedia(externalIds, false, requestUrl);

            expect(result).toEqual({ canRequest: true });
        });

        test('allows IMDB-only (server resolves via redirect)', () => {
            const externalIds: ExternalIds = { imdb: 'tt0137523' };
            const result = canRequestMedia(externalIds, false, requestUrl);

            expect(result).toEqual({ canRequest: true });
        });

        test('allows TVDB-only (server resolves via redirect)', () => {
            const externalIds: ExternalIds = { tvdb: '12345' };
            const result = canRequestMedia(externalIds, false, requestUrl);

            expect(result).toEqual({ canRequest: true });
        });

        test('blocks internal-only (the redirect cannot resolve it to TMDB)', () => {
            const externalIds: ExternalIds = {
                internal: '550e8400-e29b-41d4-a716-446655440000',
            };
            const result = canRequestMedia(externalIds, false, requestUrl);

            expect(result).toEqual({ canRequest: false, reason: 'no_external_ids' });
        });

        test('allows IMDB + TMDB', () => {
            const externalIds: ExternalIds = {
                tmdb: '550',
                imdb: 'tt0137523',
            };
            const result = canRequestMedia(externalIds, false, requestUrl);

            expect(result).toEqual({ canRequest: true });
        });

        test('blocks empty externalIds', () => {
            const result = canRequestMedia({}, false, requestUrl);

            expect(result).toEqual({
                canRequest: false,
                reason: 'no_external_ids',
            });
        });

        test('blocks when requestUrl is empty', () => {
            const externalIds: ExternalIds = { tmdb: '550' };
            const result = canRequestMedia(externalIds, false, '');

            expect(result).toEqual({
                canRequest: false,
                reason: 'requests_not_configured',
            });
        });
    });

    describe('edge cases', () => {
        test('handles externalIds with empty string values', () => {
            const externalIds: ExternalIds = { tmdb: '', imdb: '' };
            const result = canRequestMedia(externalIds, true, '');

            // Empty strings are falsy, should be treated as no valid ID
            expect(result).toEqual({
                canRequest: false,
                reason: 'no_external_ids',
            });
        });

        test('prioritizes modal enabled over external URL', () => {
            // Modal enabled should work even without requestUrl
            const externalIds: ExternalIds = { imdb: 'tt0137523' };
            const result = canRequestMedia(externalIds, true, '');

            expect(result).toEqual({ canRequest: true });
        });

        test('handles externalIds with null-like values', () => {
            const externalIds: ExternalIds = {
                tmdb: undefined,
                imdb: undefined,
            };
            const result = canRequestMedia(externalIds, true, '');

            expect(result).toEqual({
                canRequest: false,
                reason: 'no_external_ids',
            });
        });
    });
});

describe('getRequestFailureMessage', () => {
    test('returns message for no_external_ids', () => {
        const message = getRequestFailureMessage('no_external_ids');
        expect(message).toBe('No external IDs available for this content');
    });

    test('returns message for requests_not_configured', () => {
        const message = getRequestFailureMessage('requests_not_configured');
        expect(message).toBe(
            'Requests are not configured — connect Seerr (URL + API key, with the request feature enabled) or set an external request URL via PUBLIC_REQUESTURL',
        );
    });
});
