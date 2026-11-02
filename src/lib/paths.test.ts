// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
vi.mock('$app/paths', () => ({ base: '/app', resolve: (p: string) => '/app' + p }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
import { stripBase } from './paths';
it.each([
    ['/app/browse?q=matrix', '/browse?q=matrix'],
    ['/app?modal=title', '/?modal=title'],
    ['/app#section', '/#section'],
    ['/app', '/'],
    ['/application/browse', '/application/browse'],
])('strips only the complete deployment prefix from %s', (path, expected) => {
    expect(stripBase(path)).toBe(expected);
});
