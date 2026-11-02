// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { liveTvFailureFromHlsError, liveTvFailureField } from './hls-error-body';

const problem = {
    code: 'upstream_stalled',
    failure: {
        retryable: true,
        feedsTried: [{ feedId: 'feed-1', reason: 'upstream_stalled' }],
    },
    retryAfter: 5,
};

const failureInfo = {
    kind: 'failure',
    code: 'upstream_stalled',
    retryable: true,
    retryAfterMs: 5000,
    feedsTried: problem.failure.feedsTried,
};

describe('liveTvFailureFromHlsError', () => {
    it('reads a JSON string in response.data', () => {
        expect(
            liveTvFailureFromHlsError({ response: { code: 410, data: JSON.stringify(problem) } }),
        ).toEqual(failureInfo);
    });

    it('reads an already parsed object and an ArrayBuffer', () => {
        expect(liveTvFailureFromHlsError({ response: { data: problem } })).toEqual(failureInfo);
        const buffer = new TextEncoder().encode(JSON.stringify(problem)).buffer;
        expect(liveTvFailureFromHlsError({ response: { data: buffer } })).toEqual(failureInfo);
    });

    it('falls back to the XHR responseText in networkDetails', () => {
        const xhr = new XMLHttpRequest();
        Object.defineProperty(xhr, 'responseText', { value: JSON.stringify(problem) });
        expect(
            liveTvFailureFromHlsError({ response: { code: 410 }, networkDetails: xhr }),
        ).toEqual(failureInfo);
    });

    it('returns null for no body, an eviction body, garbage or a non-object', () => {
        expect(liveTvFailureFromHlsError({ response: { code: 410 } })).toBeNull();
        expect(liveTvFailureFromHlsError({ response: { data: '{"error":"evicted"}' } })).toBeNull();
        expect(liveTvFailureFromHlsError({ response: { data: 'not json' } })).toBeNull();
        expect(liveTvFailureFromHlsError(null)).toBeNull();
    });

    it('field helper spreads nothing when there is no typed body', () => {
        expect(liveTvFailureField({})).toEqual({});
        expect(liveTvFailureField({ response: { data: problem } }).liveTvFailure?.code).toBe(
            'upstream_stalled',
        );
    });
});
