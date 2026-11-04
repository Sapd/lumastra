// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * routerHopHandle must run before anything that reads the client address, the forwarded
 * protocol (cookie transport) or the raw request headers: it records whether the router hop
 * secret matched and removes the header. Order is asserted on the source of the handle chain.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hooks.server.ts handle order', () => {
    const source = readFileSync(new URL('./hooks.server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export const handle = sequence(');
    const chain = source.slice(start, source.indexOf('\n);', start));
    const names = [...chain.matchAll(/^\s{4}(\w+),$/gm)].map((m) => m[1]);

    it('routerHopHandle comes before every handle that can read the client IP or forwarded headers', () => {
        const hop = names.indexOf('routerHopHandle');
        expect(hop).toBeGreaterThanOrEqual(0);
        for (const later of [
            'cookieTransportHandle',
            'jellyfinCorsHandle',
            'shutdownGateHandle',
            'csrfHandle',
            'requestLanguageHandle',
            'paraglideHandle',
            'jellyfinResponseObserverHandle',
        ]) {
            expect(names.indexOf(later), later).toBeGreaterThan(hop);
        }
        // The route handler (mainHandle, wrapped by withRoutePolicyShadow) is last.
        expect(chain.indexOf('withRoutePolicyShadow(mainHandle')).toBeGreaterThan(
            chain.indexOf('    routerHopHandle,'),
        );
    });

    it('only the body drain wrapper and the path scope run before it, and neither reads headers for trust', () => {
        const before = names.slice(0, names.indexOf('routerHopHandle'));
        expect(before).toEqual(['requestBodyDrainHandle']);
    });

    it('the handle runs the rest of the chain inside runWithRouterHop (verdict in the async context)', () => {
        expect(source).toMatch(
            /const routerHopHandle: Handle = \(\{ event, resolve \}\) =>\s*runWithRouterHop\(event\.request, \(\) => resolve\(event\)\)/,
        );
    });
});
