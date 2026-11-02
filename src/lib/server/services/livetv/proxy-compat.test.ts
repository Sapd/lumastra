// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    LIVETV_PROXY_MIN_PROTOCOL,
    decideProxyCompat,
    readProxyBuildFile,
    type AppProxyExpectation,
} from './proxy-compat.js';
import { LIVETV_PROXY_PROTOCOL } from '../../../../shared/livetv-proxy-protocol.js';

const app: AppProxyExpectation = { protocol: 3, minProtocol: 2, build: 'aaaaaaaaaaaaaaaa' };

describe('decideProxyCompat', () => {
    it('is current when protocol is in range and the build matches', () => {
        expect(decideProxyCompat({ proxyProtocol: 3, proxyBuild: app.build }, app)).toEqual({
            state: 'current',
            proxyProtocol: 3,
        });
        // An older but still supported protocol with the same code cannot happen in
        // practice, but the build id decides "changed", not the protocol.
        expect(decideProxyCompat({ proxyProtocol: 2, proxyBuild: app.build }, app).state).toBe(
            'current',
        );
    });

    it('asks for an update when the proxy code changed since its image', () => {
        expect(
            decideProxyCompat({ proxyProtocol: 3, proxyBuild: 'bbbbbbbbbbbbbbbb' }, app),
        ).toEqual({ state: 'update', reason: 'build_differs', proxyProtocol: 3 });
        expect(
            decideProxyCompat({ proxyProtocol: 2, proxyBuild: 'bbbbbbbbbbbbbbbb' }, app),
        ).toEqual({ state: 'update', reason: 'build_differs', proxyProtocol: 2 });
    });

    it('asks for an update when the proxy predates build ids', () => {
        expect(decideProxyCompat({ proxyProtocol: 3 }, app)).toEqual({
            state: 'update',
            reason: 'build_unknown',
            proxyProtocol: 3,
        });
    });

    it('is incompatible below the minimum protocol, even with the same build id', () => {
        expect(decideProxyCompat({ proxyProtocol: 1, proxyBuild: app.build }, app)).toEqual({
            state: 'incompatible',
            reason: 'protocol_too_old',
            proxyProtocol: 1,
        });
        // No protocol at all = a proxy from before the field = protocol 0.
        expect(decideProxyCompat({}, app)).toMatchObject({
            state: 'incompatible',
            reason: 'protocol_too_old',
            proxyProtocol: 0,
        });
    });

    it('asks to align versions, without an alert, when the proxy is newer (app rolled back)', () => {
        expect(
            decideProxyCompat({ proxyProtocol: 4, proxyBuild: 'bbbbbbbbbbbbbbbb' }, app),
        ).toEqual({ state: 'update', reason: 'protocol_too_new', proxyProtocol: 4 });
    });

    it('does not compare builds when the app has no build id of its own (dev)', () => {
        const dev = { ...app, build: undefined };
        expect(
            decideProxyCompat({ proxyProtocol: 3, proxyBuild: 'bbbbbbbbbbbbbbbb' }, dev).state,
        ).toBe('unchecked');
        // The protocol check still applies.
        expect(decideProxyCompat({ proxyProtocol: 1 }, dev).state).toBe('incompatible');
    });

    it('keeps proxies that predate the protocol field working with the shipped constants', () => {
        const shipped = { protocol: LIVETV_PROXY_PROTOCOL, minProtocol: LIVETV_PROXY_MIN_PROTOCOL };
        expect(decideProxyCompat({}, { ...shipped, build: app.build })).toEqual({
            state: 'update',
            reason: 'build_unknown',
            proxyProtocol: 0,
        });
        expect(LIVETV_PROXY_MIN_PROTOCOL).toBeLessThanOrEqual(LIVETV_PROXY_PROTOCOL);
    });
});

describe('readProxyBuildFile', () => {
    it('reads a 16-hex id and rejects anything else', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-compat-'));
        const file = path.join(dir, 'livetv-proxy-build');
        fs.writeFileSync(file, 'e7292a9df2b9749b\n');
        expect(readProxyBuildFile(file)).toBe('e7292a9df2b9749b');
        fs.writeFileSync(file, 'E7292A9DF2B9749B');
        expect(readProxyBuildFile(file)).toBeUndefined();
        expect(readProxyBuildFile(path.join(dir, 'missing'))).toBeUndefined();
    });
});
