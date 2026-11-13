// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the relay credential comes from.
 *
 * `PUSH_RELAY_TOKEN` wins when set; otherwise the minted token held by the
 * enrolment loop is used.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cfg = { relayToken: '', relayUrl: 'https://push.lumastra.org' };
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get PUSH_RELAY_URL() {
                return cfg.relayUrl;
            },
            get PUSH_RELAY_TOKEN() {
                return cfg.relayToken;
            },
        },
    };
});

import {
    getRelayToken,
    setRelayToken,
    invalidateRelayToken,
    hasRelayCredential,
    relayTokenNeedsRenewal,
    onRelayTokenInvalidated,
    adoptRelayTokenIfFresher,
    heldRelayTokenExpiresAtMs,
} from './relay-token.store.js';

beforeEach(() => {
    cfg.relayToken = '';
    cfg.relayUrl = 'https://push.lumastra.org';
    setRelayToken(null);
});

describe('relay credential source', () => {
    it('is null when neither source has one', () => {
        expect(getRelayToken()).toBeNull();
        expect(hasRelayCredential()).toBe(false);
    });

    it('uses the configured token when the licence never minted one', () => {
        cfg.relayToken = 'operator-supplied';
        expect(getRelayToken()).toBe('operator-supplied');
        expect(hasRelayCredential()).toBe(true);
    });

    it('prefers the configured token over a licence-minted one', () => {
        // The operator's explicit choice wins. It is also the only one they can
        // act on: pointing PUSH_RELAY_URL at a self-hosted relay is useless if
        // the bearer is silently overridden by whatever the licence server said.
        cfg.relayToken = 'operator-supplied';
        setRelayToken('licence-minted');
        expect(getRelayToken()).toBe('operator-supplied');
    });

    it('falls back to the licence-minted token when the key is unset', () => {
        setRelayToken('licence-minted');
        expect(getRelayToken()).toBe('licence-minted');
    });

    it('treats a whitespace-only configured token as absent', () => {
        cfg.relayToken = '   ';
        expect(getRelayToken()).toBeNull();
        setRelayToken('licence-minted');
        expect(getRelayToken()).toBe('licence-minted');
    });

    it('does not let a 401 discard an operator-configured token', () => {
        // Invalidation exists so the next licence refresh can replace a stale
        // minted token. An operator-supplied value has no such replacement
        // path — dropping it would silently disable push until a restart.
        cfg.relayToken = 'operator-supplied';
        invalidateRelayToken();
        expect(getRelayToken()).toBe('operator-supplied');
    });

    it('does discard a licence-minted token on a 401', () => {
        setRelayToken('licence-minted');
        invalidateRelayToken();
        expect(getRelayToken()).toBeNull();
    });
});

describe('licence-minted token lifetime', () => {
    const NOW = 1_790_000_000_000;
    const H = 3_600_000;
    const jwtWithExp = (expSeconds: number): string => {
        const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
        return `${b64({ alg: 'ES256', typ: 'lumastra-relay+jwt' })}.${b64({ exp: expSeconds })}.sig`;
    };

    it('stops presenting a token once it has expired, so push degrades to unavailable', () => {
        setRelayToken('minted', (NOW + 24 * H) / 1000, NOW);

        expect(getRelayToken(NOW + 23 * H)).toBe('minted');
        // Inside the last minute: the relay would reject it on skew, so do not send it.
        expect(getRelayToken(NOW + 24 * H - 30_000)).toBeNull();
        expect(hasRelayCredential(NOW + 25 * H)).toBe(false);
    });

    it('reads the JWT’s own exp when the server gave no relayTokenExp', () => {
        setRelayToken(jwtWithExp((NOW + 2 * H) / 1000), undefined, NOW);

        expect(getRelayToken(NOW + H)).not.toBeNull();
        expect(getRelayToken(NOW + 3 * H)).toBeNull();
    });

    it('caps any claimed lifetime at 24h from receipt', () => {
        setRelayToken('minted', (NOW + 30 * 24 * H) / 1000, NOW);

        expect(getRelayToken(NOW + 25 * H)).toBeNull();
    });

    it('asks for renewal when none is held or less than 20h is left — i.e. on every 6h tick', () => {
        expect(relayTokenNeedsRenewal(NOW)).toBe(true);

        setRelayToken('minted', (NOW + 24 * H) / 1000, NOW);
        expect(relayTokenNeedsRenewal(NOW)).toBe(false);
        expect(relayTokenNeedsRenewal(NOW + 6 * H)).toBe(true);
    });

    it('never asks for renewal while an operator token is configured', () => {
        cfg.relayToken = 'operator-supplied';
        expect(relayTokenNeedsRenewal(NOW)).toBe(false);
    });

    it('an expired minted token does not hide behind a configured one — the configured one wins either way', () => {
        cfg.relayToken = 'operator-supplied';
        setRelayToken('minted', (NOW + H) / 1000, NOW);
        expect(getRelayToken(NOW + 2 * H)).toBe('operator-supplied');
    });

    it('tells listeners when a minted token is rejected, not when an operator token is', () => {
        const listener = vi.fn();
        const unsubscribe = onRelayTokenInvalidated(listener);
        try {
            setRelayToken('minted');
            invalidateRelayToken();
            expect(listener).toHaveBeenCalledTimes(1);

            // Nothing held → nothing was rejected.
            invalidateRelayToken();
            expect(listener).toHaveBeenCalledTimes(1);

            cfg.relayToken = 'operator-supplied';
            setRelayToken('minted');
            invalidateRelayToken();
            expect(listener).toHaveBeenCalledTimes(1);
        } finally {
            unsubscribe();
        }
    });
});

describe('adoptRelayTokenIfFresher (a sibling process minted one)', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const H = 3600_000;

    it('adopts when nothing is held', () => {
        expect(adoptRelayTokenIfFresher('shared', now + 20 * H, now)).toBe(true);
        expect(getRelayToken(now)).toBe('shared');
        expect(heldRelayTokenExpiresAtMs()).toBe(now + 20 * H);
    });

    it('adopts only a token that outlives the held one', () => {
        setRelayToken('mine', (now + 10 * H) / 1000, now);
        expect(adoptRelayTokenIfFresher('older', now + 5 * H, now)).toBe(false);
        expect(getRelayToken(now)).toBe('mine');
        expect(adoptRelayTokenIfFresher('newer', now + 22 * H, now)).toBe(true);
        expect(getRelayToken(now)).toBe('newer');
    });

    it('caps a claimed lifetime at 24h like setRelayToken', () => {
        adoptRelayTokenIfFresher('long', now + 48 * H, now);
        expect(heldRelayTokenExpiresAtMs()).toBe(now + 24 * H);
    });

    it('never overrides a configured PUSH_RELAY_TOKEN', () => {
        cfg.relayToken = 'operator';
        adoptRelayTokenIfFresher('shared', now + 20 * H, now);
        expect(getRelayToken(now)).toBe('operator');
    });
});

it.each([
    'https://relay.example',
    'http://push.lumastra.org',
    'https://push.lumastra.org:8443',
    'invalid',
])('D-L2: never sends a minted credential to %s; explicit credentials still win', (url) => {
    cfg.relayUrl = url;
    setRelayToken('minted');
    expect(getRelayToken()).toBeNull();
    cfg.relayToken = 'explicit';
    expect(getRelayToken()).toBe('explicit');
});
it('D-L2: compares origins, allowing paths and the default HTTPS port', () => {
    cfg.relayUrl = 'https://push.lumastra.org:443/relay';
    setRelayToken('minted');
    expect(getRelayToken()).toBe('minted');
});
