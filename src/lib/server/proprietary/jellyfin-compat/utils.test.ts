// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    getParam,
    getJfToken,
    getSearchTermParam,
    hasLiveTvPermission,
    MAX_SEARCH_TERM_LENGTH,
} from './utils';
import type { UserContext } from '$lib/server/types';

describe('getParam', () => {
    it('finds PascalCase param by PascalCase name', () => {
        const url = new URL('http://test?ParentId=abc');
        expect(getParam(url, 'ParentId')).toBe('abc');
    });

    it('finds lowercase param when queried by PascalCase name', () => {
        const url = new URL('http://test?parentid=abc');
        expect(getParam(url, 'ParentId')).toBe('abc');
    });

    it('finds camelCase param when queried by PascalCase name', () => {
        const url = new URL('http://test?parentId=abc');
        expect(getParam(url, 'ParentId')).toBe('abc');
    });

    it('returns null for missing param', () => {
        const url = new URL('http://test?otherparam=abc');
        expect(getParam(url, 'ParentId')).toBeNull();
    });

    it('returns empty string for empty param value', () => {
        const url = new URL('http://test?ParentId=');
        expect(getParam(url, 'ParentId')).toBe('');
    });
});

describe('getJfToken', () => {
    it('returns token when present', () => {
        expect(getJfToken({ jfToken: 'mytoken123' })).toBe('mytoken123');
    });

    it('returns empty string when missing', () => {
        expect(getJfToken({})).toBe('');
    });

    it('returns empty string when null', () => {
        expect(getJfToken({ jfToken: null })).toBe('');
    });
});

describe('hasLiveTvPermission', () => {
    it('returns false for a user without hasLiveTvPermission', () => {
        expect(hasLiveTvPermission({ hasLiveTvPermission: false } as UserContext)).toBe(false);
    });

    it('returns false for an undefined user', () => {
        expect(hasLiveTvPermission(undefined)).toBe(false);
    });

    it('returns true for a user with hasLiveTvPermission', () => {
        expect(hasLiveTvPermission({ hasLiveTvPermission: true } as UserContext)).toBe(true);
    });
});

describe('getSearchTermParam', () => {
    it('cuts a hostile SearchTerm instead of rejecting the request', () => {
        const url = new URL(`http://test?SearchTerm=${'a'.repeat(16_000)}`);
        expect(getSearchTermParam(url)?.length).toBe(MAX_SEARCH_TERM_LENGTH);
    });

    it('passes a normal term (any casing) and absence through', () => {
        expect(getSearchTermParam(new URL('http://test?searchTerm=moon'))).toBe('moon');
        expect(getSearchTermParam(new URL('http://test'))).toBeNull();
    });
});

describe('every /j SearchTerm read is length-bounded', () => {
    const SRC = path.resolve(__dirname, '../../../..');
    const ROOTS = ['routes/(proprietary)/j', 'lib/server/proprietary/jellyfin-compat'];

    function files(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) return files(full);
            return e.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(e.name) ? [full] : [];
        });
    }

    it('has no raw getParam(url, "SearchTerm") outside utils.ts', () => {
        const offenders: string[] = [];
        for (const root of ROOTS) {
            for (const file of files(path.join(SRC, root))) {
                if (file.endsWith(`jellyfin-compat${path.sep}utils.ts`)) continue;
                if (
                    /getParam\(\s*\w+,\s*['"]SearchTerm['"]\s*\)/i.test(
                        fs.readFileSync(file, 'utf8'),
                    )
                )
                    offenders.push(path.relative(SRC, file));
            }
        }
        expect(offenders).toEqual([]);
    });
});
