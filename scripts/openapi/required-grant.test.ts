// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { requiredGrantForAuth } from './required-grant.js';
import { expandScopes } from '../../src/lib/server/api/principal';

describe('requiredGrantForAuth', () => {
    it('maps user by method', () => {
        expect(requiredGrantForAuth({ kind: 'user' }, 'GET')).toBe('read');
        expect(requiredGrantForAuth({ kind: 'user' }, 'HEAD')).toBe('read');
        expect(requiredGrantForAuth({ kind: 'user' }, 'POST')).toBe('write');
        expect(requiredGrantForAuth({ kind: 'user' }, 'DELETE')).toBe('write');
    });

    it('maps admin and omits public', () => {
        expect(requiredGrantForAuth({ kind: 'admin' }, 'GET')).toBe('admin');
        expect(requiredGrantForAuth({ kind: 'public' }, 'GET')).toBeUndefined();
        expect(requiredGrantForAuth(undefined, 'GET')).toBeUndefined();
    });

    it('maps scopes to the smallest covering coarse grant', () => {
        expect(requiredGrantForAuth({ kind: 'scope', anyOf: ['media:read'] }, 'GET')).toBe('read');
        expect(requiredGrantForAuth({ kind: 'scope', anyOf: ['media:write'] }, 'POST')).toBe(
            'write',
        );
        expect(requiredGrantForAuth({ kind: 'scope', anyOf: ['tokens:admin'] }, 'GET')).toBe(
            'admin',
        );
        expect(
            requiredGrantForAuth({ kind: 'scope', anyOf: ['tokens:admin', 'media:read'] }, 'GET'),
        ).toBe('read');
    });

    it('never maps a mutation to read', () => {
        expect(requiredGrantForAuth({ kind: 'scope', anyOf: ['media:read'] }, 'POST')).toBe(
            'write',
        );
    });

    it('maps integrations:read to itself', () => {
        expect(
            requiredGrantForAuth({ kind: 'scope', anyOf: ['integrations:read', 'admin'] }, 'GET'),
        ).toBe('integrations:read');
    });

    it('maps diagnostics:read to itself, GET/HEAD only', () => {
        const spec = { kind: 'scope', anyOf: ['diagnostics:read'] };
        expect(requiredGrantForAuth(spec, 'GET')).toBe('diagnostics:read');
        expect(requiredGrantForAuth(spec, 'POST')).toBeUndefined();
    });

    it('treats integrations:read as incomparable with the coarse grants', () => {
        const integ = { kind: 'scope', anyOf: ['integrations:read'] };
        expect(
            requiredGrantForAuth({ kind: 'all', specs: [integ, { kind: 'user' }] }, 'GET'),
        ).toBeUndefined();
        expect(
            requiredGrantForAuth({ kind: 'any', specs: [integ, { kind: 'admin' }] }, 'GET'),
        ).toBeUndefined();
        expect(requiredGrantForAuth({ kind: 'all', specs: [integ, integ] }, 'GET')).toBe(
            'integrations:read',
        );
        expect(requiredGrantForAuth({ kind: 'any', specs: [integ, integ] }, 'GET')).toBe(
            'integrations:read',
        );
    });

    it('maps no mutation to integrations:read', () => {
        const integ = { kind: 'scope', anyOf: ['integrations:read'] };
        expect(requiredGrantForAuth(integ, 'POST')).toBeUndefined();
        expect(requiredGrantForAuth(integ, 'HEAD')).toBe('integrations:read');
    });

    it('recurses through feature, all and any', () => {
        expect(
            requiredGrantForAuth({ kind: 'feature', flag: 'x', then: { kind: 'admin' } }, 'GET'),
        ).toBe('admin');
        expect(
            requiredGrantForAuth(
                { kind: 'all', specs: [{ kind: 'user' }, { kind: 'admin' }] },
                'GET',
            ),
        ).toBe('admin');
        expect(
            requiredGrantForAuth(
                { kind: 'any', specs: [{ kind: 'user' }, { kind: 'admin' }] },
                'GET',
            ),
        ).toBe('read');
        expect(
            requiredGrantForAuth(
                { kind: 'any', specs: [{ kind: 'public' }, { kind: 'admin' }] },
                'GET',
            ),
        ).toBeUndefined();
    });

    it('agrees with expandScopes: the chosen grant covers the scope and no smaller one does', () => {
        const all = new Set([
            ...expandScopes(['admin']),
            ...expandScopes(['write']),
            ...expandScopes(['read']),
        ]);
        const order = ['read', 'write', 'admin'];
        for (const scope of all) {
            const g = requiredGrantForAuth({ kind: 'scope', anyOf: [scope] }, 'GET');
            expect(g, scope).toBeDefined();
            expect(expandScopes([g as string]), scope).toContain(scope);
            for (const smaller of order.slice(0, order.indexOf(g as string))) {
                expect(expandScopes([smaller]), scope).not.toContain(scope);
            }
        }
    });
});
