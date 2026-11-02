// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    DEPRECATION_POLICY_URL,
    deprecationHeaders,
    deprecationProblem,
    fillPathParams,
    withDeprecationHeaders,
} from './deprecation';

const policyLink = `<${DEPRECATION_POLICY_URL}>; rel="deprecation"`;

describe('deprecationHeaders', () => {
    it('formats Deprecation, Sunset, the successor and the policy Link', () => {
        expect(
            deprecationHeaders(
                { since: '2026-11-01', sunset: '2027-02-01', replacement: '/diagnostics/events' },
                '/api/v1/diagnostics/events',
            ),
        ).toEqual({
            Deprecation: '@1793491200',
            Sunset: 'Mon, 01 Feb 2027 00:00:00 GMT',
            Link: `</api/v1/diagnostics/events>; rel="successor-version", ${policyLink}`,
        });
    });

    it('leaves Sunset out until a removal date is announced, and the successor out when it cannot be built', () => {
        const headers = deprecationHeaders({ since: '2026-11-01', replacement: '/x/{id}' }, null);
        expect(headers).not.toHaveProperty('Sunset');
        expect(headers.Link).toBe(policyLink);
    });
});

describe('deprecationProblem', () => {
    it('accepts a well-formed block', () => {
        expect(deprecationProblem({ since: '2026-11-01', sunset: '2027-02-01', replacement: '/x' })).toBeNull();
    });

    it.each([
        [{ since: '2026-11-1', replacement: '/x' }, 'since "2026-11-1" is not a YYYY-MM-DD date'],
        [{ since: '2026-11-01', sunset: 'soon', replacement: '/x' }, 'sunset "soon" is not a YYYY-MM-DD date'],
        [{ since: '2026-11-01', sunset: '2026-12-01', replacement: '/x' }, 'sunset is 30 days after since; the policy needs at least 90'],
        [{ since: '2026-11-01', replacement: 'diagnostics/events' }, 'replacement must be a path starting with /'],
    ])('rejects %j', (info, problem) => {
        expect(deprecationProblem(info)).toBe(problem);
    });
});

describe('fillPathParams', () => {
    it('fills id params from the request', () => {
        expect(fillPathParams('/media/{id}/rating', { id: 'a b' })).toBe('/media/a%20b/rating');
    });

    it('returns null when a param is missing', () => {
        expect(fillPathParams('/media/{id}/rating', {})).toBeNull();
    });
});

describe('withDeprecationHeaders', () => {
    it('sets the headers on a mutable response and keeps an existing Link', () => {
        const response = new Response('{}', { status: 200, headers: { Link: '</next>; rel="next"' } });
        const out = withDeprecationHeaders(response, { Deprecation: '@1', Link: policyLink });
        expect(out).toBe(response);
        expect(out.headers.get('deprecation')).toBe('@1');
        expect(out.headers.get('link')).toBe(`</next>; rel="next", ${policyLink}`);
    });

    it('re-wraps a response whose headers are immutable', () => {
        const response = Response.redirect('https://example.test/next', 302);
        const out = withDeprecationHeaders(response, { Deprecation: '@1' });
        expect(out.status).toBe(302);
        expect(out.headers.get('deprecation')).toBe('@1');
        expect(out.headers.get('location')).toBe('https://example.test/next');
    });
});
