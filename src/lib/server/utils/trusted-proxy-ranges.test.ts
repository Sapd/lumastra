// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    describeWideTrustedProxyRanges,
    findWideTrustedProxyRanges,
    runsOnKubernetes,
} from './trusted-proxy-ranges.js';

describe('findWideTrustedProxyRanges', () => {
    it.each([undefined, '', '  ', ' , '])('nothing configured (%j): null', (raw) => {
        expect(findWideTrustedProxyRanges(raw)).toBeNull();
    });

    it('single IPv4 and IPv6 addresses are never flagged', () => {
        expect(
            findWideTrustedProxyRanges('172.28.0.10, 10.0.0.5,::1,fd00::10,::ffff:10.0.0.5'),
        ).toBeNull();
    });

    it.each(['10.0.0.0/24', '172.28.0.0/24', '192.168.1.128/25', '10.42.1.2/31', '10.0.0.5/32'])(
        '%s (/24 or narrower): not flagged',
        (entry) => {
            expect(findWideTrustedProxyRanges(entry)).toBeNull();
        },
    );

    it.each([
        '10.0.0.0/23',
        '172.18.0.0/16',
        '192.168.0.0/16',
        '172.16.0.0/12',
        '10.0.0.0/8',
        '0.0.0.0/0',
    ])('%s (wider than /24): flagged', (entry) => {
        expect(findWideTrustedProxyRanges(entry)).toEqual({ wide: [entry], unsupported: [] });
    });

    it('the compose subnet the docs define (/24) passes, a Docker default /16 is flagged', () => {
        expect(findWideTrustedProxyRanges('172.28.0.0/24')).toBeNull();
        expect(findWideTrustedProxyRanges('172.28.0.10')).toBeNull();
        expect(findWideTrustedProxyRanges('172.18.0.0/16')?.wide).toEqual(['172.18.0.0/16']);
    });

    it("prod's per-node pod ranges (/25 .. /31) are not flagged", () => {
        expect(
            findWideTrustedProxyRanges(
                '10.42.1.2/31,10.42.1.4/30,10.42.1.8/29,10.42.1.16/28,10.42.1.32/27,10.42.1.64/26,10.42.1.128/25',
            ),
        ).toBeNull();
    });

    it('IPv6 ranges are reported as unsupported (they match nothing), whatever the prefix', () => {
        expect(findWideTrustedProxyRanges('fd00::/8, 2001:db8::/64, fd00::10/128')).toEqual({
            wide: [],
            unsupported: ['fd00::/8', '2001:db8::/64', 'fd00::10/128'],
        });
    });

    it('a mapped IPv4 range is unsupported like any IPv6 range (client-ip.ts treats it as exact)', () => {
        expect(findWideTrustedProxyRanges('::ffff:10.0.0.0/104')?.unsupported).toEqual([
            '::ffff:10.0.0.0/104',
        ]);
    });

    it('an empty prefix is /0 to the matcher, so it is flagged', () => {
        expect(findWideTrustedProxyRanges('10.0.0.0/')?.wide).toEqual(['10.0.0.0/']);
    });

    it('malformed IPv4 ranges are ignored (the matcher keeps them as a non-matching exact string)', () => {
        expect(
            findWideTrustedProxyRanges('10.0.0.0/33,10.0.0/8,300.0.0.0/8,10.0.0.0/abc'),
        ).toBeNull();
    });

    it('mixed lists report only the offending entries, verbatim', () => {
        expect(findWideTrustedProxyRanges('172.28.0.10, 192.168.0.0/16 ,fd00::/8')).toEqual({
            wide: ['192.168.0.0/16'],
            unsupported: ['fd00::/8'],
        });
    });
});

describe('describeWideTrustedProxyRanges', () => {
    const base = { forwardAuthEnabled: false, kubernetes: false };

    it('null when nothing is flagged', () => {
        expect(
            describeWideTrustedProxyRanges({ ...base, trustedProxyIps: '172.28.0.10' }),
        ).toBeNull();
    });

    it('wide range with forward auth off: warn, says what turning it on would do', () => {
        const r = describeWideTrustedProxyRanges({ ...base, trustedProxyIps: '192.168.0.0/16' });
        expect(r?.severity).toBe('warn');
        expect(r?.message).toContain('192.168.0.0/16');
        expect(r?.message).toContain('If FORWARD_AUTH_ENABLED is turned on');
        expect(r?.remediation).toContain('fixed IP');
    });

    it('wide range with forward auth on: warn, says any device can sign in as anyone', () => {
        const r = describeWideTrustedProxyRanges({
            ...base,
            forwardAuthEnabled: true,
            trustedProxyIps: '192.168.0.0/16',
        });
        expect(r?.severity).toBe('warn');
        expect(r?.message).toContain('FORWARD_AUTH_ENABLED is on');
        expect(r?.message).toContain('sign in as any user');
    });

    it('wide range on Kubernetes (pod CIDR behind a NetworkPolicy): info', () => {
        const r = describeWideTrustedProxyRanges({
            ...base,
            kubernetes: true,
            trustedProxyIps: '10.42.0.0/16',
        });
        expect(r?.severity).toBe('info');
        expect(r?.remediation).toContain('NetworkPolicy');
    });

    it.each(['0.0.0.0/0', '8.0.0.0/8', '10.0.0.0/7', '172.16.0.0/11'])(
        '%s on Kubernetes (not wholly private): still a warning',
        (range) => {
            const r = describeWideTrustedProxyRanges({
                ...base,
                kubernetes: true,
                trustedProxyIps: range,
            });
            expect(r?.severity).toBe('warn');
            expect(r?.remediation).not.toContain('NetworkPolicy');
        },
    );

    it.each(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'])(
        '%s on Kubernetes (private): info',
        (range) => {
            expect(
                describeWideTrustedProxyRanges({
                    ...base,
                    kubernetes: true,
                    trustedProxyIps: range,
                })?.severity,
            ).toBe('info');
        },
    );

    it('an IPv6 range stays a warning on Kubernetes: forward auth through it cannot work', () => {
        const r = describeWideTrustedProxyRanges({
            ...base,
            kubernetes: true,
            trustedProxyIps: '10.42.0.0/16,fd00::/8',
        });
        expect(r?.severity).toBe('warn');
        expect(r?.message).toContain('IPv6 ranges are not supported');
    });
});

describe('runsOnKubernetes', () => {
    it('reads KUBERNETES_SERVICE_HOST', () => {
        expect(runsOnKubernetes({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe(true);
        expect(runsOnKubernetes({ KUBERNETES_SERVICE_HOST: '' })).toBe(false);
        expect(runsOnKubernetes({})).toBe(false);
    });
});
