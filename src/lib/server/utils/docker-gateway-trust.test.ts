// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseDefaultGateway,
    trustedEntriesCovering,
    detectGatewayTrust,
    describeGatewayTrust,
    warnIfTrustedProxyCoversGateway,
    resetGatewayTrustWarning,
} from './docker-gateway-trust.js';

// Real /proc/net/route from a container on a user-defined bridge 172.21.0.0/16
// (tab-separated, trailing padding as the kernel writes it).
const DOCKER_ROUTE = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT       ',
    'eth0\t00000000\t010015AC\t0003\t0\t0\t0\t00000000\t0\t0\t0                                ',
    'eth0\t000015AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0                                ',
    '',
].join('\n');

describe('parseDefaultGateway', () => {
    it('decodes the little-endian default-route gateway', () => {
        expect(parseDefaultGateway(DOCKER_ROUTE)).toBe('172.21.0.1');
    });

    it('decodes the default docker0 bridge gateway', () => {
        const route =
            'Iface\tDestination\tGateway\tFlags\n' +
            'eth0\t000011AC\t00000000\t0001\n' +
            'eth0\t00000000\t010011AC\t0003\n';
        expect(parseDefaultGateway(route)).toBe('172.17.0.1');
    });

    it('is null without a default route (e.g. --network none) or for empty input', () => {
        expect(
            parseDefaultGateway(
                'Iface\tDestination\tGateway\tFlags\nlo\t0000007F\t00000000\t0001\n',
            ),
        ).toBeNull();
        expect(parseDefaultGateway('')).toBeNull();
    });

    it('ignores a default route without the RTF_GATEWAY flag', () => {
        expect(
            parseDefaultGateway(
                'Iface\tDestination\tGateway\tFlags\neth0\t00000000\t010015AC\t0001\n',
            ),
        ).toBeNull();
    });
});

describe('trustedEntriesCovering', () => {
    it('matches an exact entry and a CIDR that contains the address', () => {
        expect(trustedEntriesCovering('10.0.0.5, 172.21.0.1, 172.16.0.0/12', '172.21.0.1')).toEqual(
            ['172.21.0.1', '172.16.0.0/12'],
        );
    });

    it('matches an IPv4-mapped IPv6 spelling of the gateway', () => {
        expect(trustedEntriesCovering('::ffff:172.21.0.1', '172.21.0.1')).toEqual([
            '::ffff:172.21.0.1',
        ]);
    });

    it('does not match the proxy container’s own address or another subnet', () => {
        expect(
            trustedEntriesCovering('172.21.0.10, 172.22.0.0/16, 172.21.0.8/30', '172.21.0.1'),
        ).toEqual([]);
    });

    it('skips IPv6 and malformed entries', () => {
        expect(trustedEntriesCovering('fd00::1, 172.21.0.0/99, bogus', '172.21.0.1')).toEqual([]);
    });
});

describe('detectGatewayTrust', () => {
    it('flags TRUSTED_PROXY_IPS set to the Docker gateway', () => {
        expect(
            detectGatewayTrust({ trustedProxyIps: '172.21.0.1', procNetRoute: DOCKER_ROUTE }),
        ).toEqual({ gateway: '172.21.0.1', entries: ['172.21.0.1'] });
    });

    it('flags a subnet that includes the gateway', () => {
        expect(
            detectGatewayTrust({ trustedProxyIps: '172.21.0.0/16', procNetRoute: DOCKER_ROUTE }),
        ).toEqual({ gateway: '172.21.0.1', entries: ['172.21.0.0/16'] });
    });

    it('is quiet for a pinned proxy-container address', () => {
        expect(
            detectGatewayTrust({ trustedProxyIps: '172.21.0.10', procNetRoute: DOCKER_ROUTE }),
        ).toBeNull();
    });

    it('is quiet without TRUSTED_PROXY_IPS or without a route table (non-Linux)', () => {
        expect(detectGatewayTrust({ trustedProxyIps: '', procNetRoute: DOCKER_ROUTE })).toBeNull();
        expect(
            detectGatewayTrust({ trustedProxyIps: undefined, procNetRoute: DOCKER_ROUTE }),
        ).toBeNull();
        expect(
            detectGatewayTrust({ trustedProxyIps: '172.21.0.1', procNetRoute: null }),
        ).toBeNull();
    });
});

describe('describeGatewayTrust', () => {
    it('says "is" for the exact gateway and "contains" for a subnet', () => {
        expect(
            describeGatewayTrust({ gateway: '172.21.0.1', entries: ['172.21.0.1'] }).message,
        ).toContain("is the container's default gateway (172.21.0.1)");
        expect(
            describeGatewayTrust({ gateway: '172.21.0.1', entries: ['172.21.0.0/16'] }).message,
        ).toContain("contains the container's default gateway (172.21.0.1)");
    });

    it('recommends the same-network proxy with no published port', () => {
        const { remediation } = describeGatewayTrust({
            gateway: '172.21.0.1',
            entries: ['172.21.0.1'],
        });
        expect(remediation).toMatch(/same Docker network/);
        expect(remediation).toMatch(/do not publish the app port/);
    });
});

describe('warnIfTrustedProxyCoversGateway (boot)', () => {
    beforeEach(() => resetGatewayTrustWarning());

    it('warns exactly once per process', () => {
        const warn = vi.fn();
        const input = { trustedProxyIps: '172.21.0.1', procNetRoute: DOCKER_ROUTE };
        warnIfTrustedProxyCoversGateway(warn, input);
        warnIfTrustedProxyCoversGateway(warn, input);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('TRUSTED_PROXY_IPS entry 172.21.0.1');
        expect(warn.mock.calls[0][1]).toEqual({ gateway: '172.21.0.1', entries: ['172.21.0.1'] });
    });

    it('stays silent for a safe configuration', () => {
        const warn = vi.fn();
        expect(
            warnIfTrustedProxyCoversGateway(warn, {
                trustedProxyIps: '172.21.0.10',
                procNetRoute: DOCKER_ROUTE,
            }),
        ).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });
});
