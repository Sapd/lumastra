// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the .env.example placeholder detector (B2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    isPlaceholderValue,
    noteIgnoredPlaceholder,
    _resetPlaceholderWarningStateForTests,
} from './config-placeholders';

describe('isPlaceholderValue', () => {
    it('is false for an empty/blank string (that is just "unset")', () => {
        expect(isPlaceholderValue('')).toBe(false);
        expect(isPlaceholderValue('   ')).toBe(false);
    });

    it('flags your_* sample tokens', () => {
        expect(isPlaceholderValue('your_tmdb_api_key')).toBe(true);
        expect(isPlaceholderValue('your_voyage_api_key')).toBe(true);
        expect(isPlaceholderValue('your_mdblist_api_key')).toBe(true);
        expect(isPlaceholderValue('your_jellyfin_api_key')).toBe(true);
    });

    it('flags changeme* sample passwords', () => {
        expect(isPlaceholderValue('changeme_generate_a_strong_password')).toBe(true);
        expect(isPlaceholderValue('ChangeMeNow')).toBe(true);
    });

    it('flags sk-your_* / sk-ant-your_* sample API keys', () => {
        expect(isPlaceholderValue('sk-your_openai_api_key')).toBe(true);
        expect(isPlaceholderValue('sk-ant-your_anthropic_api_key')).toBe(true);
    });

    it('flags URLs whose host is example.com or a subdomain of it', () => {
        expect(isPlaceholderValue('https://kavita.example.com')).toBe(true);
        expect(isPlaceholderValue('https://dashboard.example.com')).toBe(true);
        expect(isPlaceholderValue('http://example.com')).toBe(true);
    });

    it('does not flag real-looking values', () => {
        expect(isPlaceholderValue('abcd1234realapikey')).toBe(false);
        expect(isPlaceholderValue('http://jellyfin:8096')).toBe(false);
        expect(isPlaceholderValue('https://kavita.mydomain.tld')).toBe(false);
        expect(isPlaceholderValue('sk-proj-realkeyvalue')).toBe(false);
    });
});

describe('noteIgnoredPlaceholder', () => {
    beforeEach(() => {
        _resetPlaceholderWarningStateForTests();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('logs exactly one combined warning even when several keys are ignored', () => {
        const warn = vi.fn();
        noteIgnoredPlaceholder('TMDB_API_KEY', warn);
        noteIgnoredPlaceholder('VOYAGE_API_KEY', warn);
        noteIgnoredPlaceholder('TMDB_API_KEY', warn); // duplicate, ignored

        expect(warn).not.toHaveBeenCalled();
        vi.runAllTimers();

        expect(warn).toHaveBeenCalledTimes(1);
        const message = warn.mock.calls[0][0] as string;
        expect(message).toContain('TMDB_API_KEY');
        expect(message).toContain('VOYAGE_API_KEY');
    });
});
