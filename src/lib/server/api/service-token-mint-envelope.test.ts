// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A service token minted BY a service token may never get more than its
 * minter. These cases pin the
 * pure envelope rule; the end-to-end mint + use is covered by
 * `defs/service-tokens/minted-by-service-token.integration.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
    mintEnvelopeViolation,
    pathPrefixCoveredBy,
    type MinterEnvelope,
    type ChildMintRequest,
} from './service-token-mint-envelope.js';

const USER_A = '00000000-0000-0000-0000-0000000000a1';
const USER_B = '00000000-0000-0000-0000-0000000000b2';

function minter(over: Partial<MinterEnvelope> = {}): MinterEnvelope {
    return {
        id: 101,
        name: 'test-minter',
        createdBy: 'testowner',
        ownerUserId: USER_B,
        actAsUser: null,
        scopes: ['admin'],
        allowedIps: null,
        allowedPathPrefixes: null,
        allowedMethods: null,
        forceNonAdmin: false,
        expiresAt: null,
        ...over,
    };
}

function child(over: Partial<ChildMintRequest> = {}): ChildMintRequest {
    return { scopes: ['read'], expiresAt: null, ...over };
}

describe('pathPrefixCoveredBy', () => {
    it('matches the request-time boundary rule', () => {
        expect(pathPrefixCoveredBy('/api/v1/media', '/api/v1/media')).toBe(true);
        expect(pathPrefixCoveredBy('/api/v1/media/abc', '/api/v1/media')).toBe(true);
        expect(pathPrefixCoveredBy('/api/v1/media/abc', '/api/v1/media/')).toBe(true);
        // '/api/v1/media-x' is NOT under '/api/v1/media' at request time.
        expect(pathPrefixCoveredBy('/api/v1/media-x', '/api/v1/media')).toBe(false);
        // '/api/v1/media' (exact) is not matched by a '/api/v1/media/' minter.
        expect(pathPrefixCoveredBy('/api/v1/media', '/api/v1/media/')).toBe(false);
        expect(pathPrefixCoveredBy('/api/v1/', '/api/v1/media')).toBe(false);
    });
});

describe('mintEnvelopeViolation', () => {
    it('allows child tokens under an unrestricted admin minter', () => {
        expect(
            mintEnvelopeViolation(
                minter(),
                child({
                    scopes: ['read'],
                    actAsUserId: USER_A,
                    allowedPathPrefixes: ['/api/v1/search', '/api/v1/media/', '/api/v1/series/'],
                    allowedMethods: ['GET'],
                }),
            ),
        ).toBeNull();
        expect(
            mintEnvelopeViolation(
                minter(),
                child({
                    scopes: ['admin'],
                    allowedPathPrefixes: ['/api/v1/integrations/homepage'],
                    allowedMethods: ['GET'],
                }),
            ),
        ).toBeNull();
    });

    it('lets a child carry integrations:read only when the minter literally holds it', () => {
        expect(mintEnvelopeViolation(minter(), child({ scopes: ['integrations:read'] }))).toMatch(
            /integrations:read/,
        );
    });

    it('lets a child carry diagnostics:read only when the minter literally holds it', () => {
        expect(mintEnvelopeViolation(minter(), child({ scopes: ['diagnostics:read'] }))).toMatch(
            /diagnostics:read/,
        );
        expect(
            mintEnvelopeViolation(
                minter({ scopes: ['admin', 'diagnostics:read'] }),
                child({ scopes: ['diagnostics:read'] }),
            ),
        ).toBeNull();
    });

    it('requires the minter to carry the admin scope', () => {
        expect(mintEnvelopeViolation(minter({ scopes: ['write'] }), child())).toMatch(
            /admin scope/,
        );
    });

    describe('path prefixes', () => {
        const restricted = minter({ allowedPathPrefixes: ['/api/v1/integrations/'] });

        it('allows a narrower child', () => {
            expect(
                mintEnvelopeViolation(
                    restricted,
                    child({ allowedPathPrefixes: ['/api/v1/integrations/homepage'] }),
                ),
            ).toBeNull();
        });

        it('rejects a child with no path restriction', () => {
            expect(mintEnvelopeViolation(restricted, child())).toMatch(/path/);
            expect(mintEnvelopeViolation(restricted, child({ allowedPathPrefixes: [] }))).toMatch(
                /path/,
            );
        });

        it('rejects a child prefix outside the minter', () => {
            expect(
                mintEnvelopeViolation(
                    restricted,
                    child({
                        allowedPathPrefixes: ['/api/v1/integrations/homepage', '/api/v1/media/'],
                    }),
                ),
            ).toMatch(/\/api\/v1\/media\//);
        });
    });

    describe('methods', () => {
        const getOnly = minter({ allowedMethods: ['GET'] });

        it('allows a subset (case-insensitive)', () => {
            expect(mintEnvelopeViolation(getOnly, child({ allowedMethods: ['get'] }))).toBeNull();
        });

        it('rejects an unrestricted child or an extra method', () => {
            expect(mintEnvelopeViolation(getOnly, child())).toMatch(/method/);
            expect(
                mintEnvelopeViolation(getOnly, child({ allowedMethods: ['GET', 'POST'] })),
            ).toMatch(/POST/);
        });
    });

    describe('IP allowlist', () => {
        const pinned = minter({ allowedIps: ['10.0.0.5', '10.0.0.6'] });

        it('allows a subset, IPv6-mapped spelling included', () => {
            expect(
                mintEnvelopeViolation(pinned, child({ allowedIps: ['::ffff:10.0.0.5'] })),
            ).toBeNull();
        });

        it('rejects an unrestricted child or an extra IP', () => {
            expect(mintEnvelopeViolation(pinned, child())).toMatch(/IP/);
            expect(mintEnvelopeViolation(pinned, child({ allowedIps: ['10.0.0.7'] }))).toMatch(
                /10\.0\.0\.7/,
            );
        });
    });

    it('carries forceNonAdmin down', () => {
        const narrowed = minter({ forceNonAdmin: true });
        expect(mintEnvelopeViolation(narrowed, child())).toMatch(/forceNonAdmin/);
        expect(mintEnvelopeViolation(narrowed, child({ forceNonAdmin: true }))).toBeNull();
    });

    it('never outlives the minter', () => {
        const expiresAt = new Date('2026-12-01T00:00:00Z');
        const expiring = minter({ expiresAt });
        expect(mintEnvelopeViolation(expiring, child())).toMatch(/expire/);
        expect(
            mintEnvelopeViolation(expiring, child({ expiresAt: new Date('2026-12-02T00:00:00Z') })),
        ).toMatch(/expire/);
        expect(
            mintEnvelopeViolation(expiring, child({ expiresAt: new Date('2026-11-30T00:00:00Z') })),
        ).toBeNull();
    });

    describe('actAsUser', () => {
        it('an unrestricted minter may mint an impersonating child', () => {
            expect(mintEnvelopeViolation(minter(), child({ actAsUserId: USER_A }))).toBeNull();
        });

        it('an impersonating minter may only mint for the same user', () => {
            const imp = minter({ actAsUser: USER_A });
            expect(mintEnvelopeViolation(imp, child({ actAsUserId: USER_A }))).toBeNull();
            expect(mintEnvelopeViolation(imp, child({ actAsUserId: USER_B }))).toMatch(/actAsUser/);
            // No actAsUser would act as the OWNER — more than the minter can.
            expect(mintEnvelopeViolation(imp, child())).toMatch(/actAsUser/);
        });
    });
});
