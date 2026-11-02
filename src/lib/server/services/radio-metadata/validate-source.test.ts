// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-12, C7 follow-up: an unsafe now-playing regex was
 * only caught at parse time (per poll, per station). Reject it when the admin
 * SAVES the station, with the reason, so a bad pattern never reaches the DB.
 */

import { describe, it, expect } from 'vitest';
import { metadataSourceIssues } from './validate-source.js';

describe('metadataSourceIssues', () => {
    it('accepts an ordinary station pattern', () => {
        expect(
            metadataSourceIssues({
                url: 'https://radio.example/now',
                format: 'regex',
                regexPattern: '(?<artist>.+) - (?<title>.+)',
            }),
        ).toBeNull();
    });

    it.each(['(a|a)+', '((a|b)+)+', '(a*){2,}'])(
        'rejects the unsafe pattern %s with a reason',
        (p) => {
            const issues = metadataSourceIssues({
                url: 'https://radio.example/now',
                format: 'regex',
                regexPattern: p,
            });
            expect(issues).not.toBeNull();
            expect(issues![0].field).toBe('metadataSource.regexPattern');
            expect(issues![0].message.length).toBeGreaterThan(0);
        },
    );

    it('rejects a pattern that does not compile', () => {
        const issues = metadataSourceIssues({
            url: 'https://radio.example/now',
            format: 'regex',
            regexPattern: '(?<title>',
        });
        expect(issues?.[0].field).toBe('metadataSource.regexPattern');
    });

    it('ignores the pattern for json sources and absent sources', () => {
        expect(
            metadataSourceIssues({
                url: 'https://radio.example/now',
                format: 'json',
                regexPattern: '(a|a)+',
            }),
        ).toBeNull();
        expect(metadataSourceIssues(undefined)).toBeNull();
        expect(metadataSourceIssues(null)).toBeNull();
    });
});
