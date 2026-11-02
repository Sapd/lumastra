// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    compareSemver,
    evaluateUpdate,
    isSecurityRelease,
    parseRunningVersion,
    parseSemver,
    type ReleaseInfo,
} from './version.js';

function cmp(a: string, b: string): number {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) throw new Error(`not semver: ${a} / ${b}`);
    return Math.sign(compareSemver(pa, pb));
}

function rel(version: string, over: Partial<ReleaseInfo> = {}): ReleaseInfo {
    return {
        version,
        url: `https://github.com/Sapd/lumastra/releases/tag/v${version}`,
        publishedAt: '2026-11-01T00:00:00Z',
        security: false,
        prerelease: version.includes('-'),
        ...over,
    };
}

describe('compareSemver', () => {
    it('orders major, minor, patch numerically (not as strings)', () => {
        expect(cmp('0.10.0', '0.9.0')).toBe(1);
        expect(cmp('1.0.0', '0.99.99')).toBe(1);
        expect(cmp('0.1.2', '0.1.10')).toBe(-1);
        expect(cmp('v0.1.0', '0.1.0')).toBe(0);
    });

    it('ranks a release above its own pre-releases', () => {
        expect(cmp('0.2.0', '0.2.0-rc.1')).toBe(1);
        expect(cmp('0.2.0-rc.1', '0.1.9')).toBe(1);
    });

    it('follows semver §11 for pre-release identifiers', () => {
        expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
        expect(cmp('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
        expect(cmp('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
        expect(cmp('1.0.0-rc.1', '1.0.0-beta.11')).toBe(1);
    });

    it('ignores build metadata', () => {
        expect(cmp('0.1.0+abc', '0.1.0')).toBe(0);
    });

    it('rejects non-semver', () => {
        expect(parseSemver('abc1234')).toBeNull();
        expect(parseSemver('1.2')).toBeNull();
        expect(parseSemver('unknown')).toBeNull();
    });
});

describe('parseRunningVersion', () => {
    it('reads a release tag', () => {
        const v = parseRunningVersion('v0.2.0');
        expect(v.semver).toMatchObject({ major: 0, minor: 2, patch: 0, prerelease: [] });
        expect(v.distance).toBe(0);
    });

    it('reads an :edge / dev describe string as base tag + distance', () => {
        const v = parseRunningVersion('v0.2.0-14-gab12cd3-dirty');
        expect(v.semver).toMatchObject({ major: 0, minor: 2, patch: 0, prerelease: [] });
        expect(v.distance).toBe(14);
    });

    it('keeps a pre-release tag as a pre-release, with or without distance', () => {
        expect(parseRunningVersion('v0.3.0-rc.1').semver?.prerelease).toEqual(['rc', '1']);
        const edge = parseRunningVersion('v0.3.0-rc.1-2-gdeadbeef');
        expect(edge.semver?.prerelease).toEqual(['rc', '1']);
        expect(edge.distance).toBe(2);
    });

    it('reads the package.json fallback as a dev build and gives up on a bare sha', () => {
        expect(parseRunningVersion('0.1.0+ab12cd3')).toMatchObject({ devBuild: true });
        expect(parseRunningVersion('v0.1.0')).toMatchObject({ devBuild: false });
        expect(parseRunningVersion('v0.1.0-3-gab12cd3')).toMatchObject({ devBuild: true });
        expect(parseRunningVersion('ab12cd3').semver).toBeNull();
        expect(parseRunningVersion('unknown').semver).toBeNull();
    });
});

describe('isSecurityRelease', () => {
    it('finds a "Security: yes" line, any case, markdown tolerated', () => {
        expect(isSecurityRelease('Fixes.\n\nSecurity: yes\n')).toBe(true);
        expect(isSecurityRelease('security:YES')).toBe(true);
        expect(isSecurityRelease('**Security:** yes')).toBe(true);
        expect(isSecurityRelease('- Security: yes')).toBe(true);
        expect(isSecurityRelease('> Security: Yes.')).toBe(true);
    });

    it('needs the whole line: generated notes and prose do not count', () => {
        expect(isSecurityRelease('* Security: yes by @someone in #12')).toBe(false);
        expect(isSecurityRelease('- Security: yes, see below')).toBe(false);
    });

    it('does not fire on prose that merely mentions security', () => {
        expect(isSecurityRelease('Security: no')).toBe(false);
        expect(isSecurityRelease('Improved security headers.')).toBe(false);
        expect(isSecurityRelease('### Security\n- nothing this time')).toBe(false);
        expect(isSecurityRelease(null)).toBe(false);
    });

    it('treats a link to an advisory of this repository as a security release', () => {
        expect(
            isSecurityRelease(
                'See https://github.com/Sapd/lumastra/security/advisories/GHSA-4v6j-hq2c-x7p8',
            ),
        ).toBe(true);
        // A bare id or another repository's advisory is only a mention.
        expect(isSecurityRelease('Not affected by GHSA-4v6j-hq2c-x7p8.')).toBe(false);
        expect(
            isSecurityRelease(
                'https://github.com/other/repo/security/advisories/GHSA-4v6j-hq2c-x7p8',
            ),
        ).toBe(false);
    });
});

describe('evaluateUpdate', () => {
    const on = (v: string, buildTime?: string) =>
        evaluateUpdate(RELEASES, parseRunningVersion(v), buildTime);
    const RELEASES = [
        rel('0.1.0', { publishedAt: '2026-10-15T00:00:00Z' }),
        rel('0.1.1', { security: true, publishedAt: '2026-10-20T00:00:00Z' }),
        rel('0.1.2', { publishedAt: '2026-10-25T00:00:00Z' }),
        rel('0.2.0-rc.1', { publishedAt: '2026-10-28T00:00:00Z' }),
    ];

    it('names the latest release and the security release in between', () => {
        const e = on('v0.1.0');
        expect(e.latest?.version).toBe('0.1.2');
        expect(e.securityFixedIn?.version).toBe('0.1.1');
    });

    it('drops the security flag once the fixed version is installed', () => {
        const e = on('v0.1.1');
        expect(e.latest?.version).toBe('0.1.2');
        expect(e.securityFixedIn).toBeNull();
    });

    it('says nothing when the install is current', () => {
        expect(on('v0.1.2')).toEqual({
            latest: null,
            securityFixedIn: null,
            securityReviewed: null,
            comparable: true,
        });
    });

    it('ignores pre-releases unless the install runs one', () => {
        expect(on('v0.1.2').latest).toBeNull();
        const rc = evaluateUpdate(
            [...RELEASES, rel('0.2.0-rc.2')],
            parseRunningVersion('v0.2.0-rc.1'),
        );
        expect(rc.latest?.version).toBe('0.2.0-rc.2');
    });

    it('a pre-release install is still told about the final release', () => {
        const e = evaluateUpdate([rel('0.2.0')], parseRunningVersion('v0.2.0-rc.1'));
        expect(e.latest?.version).toBe('0.2.0');
    });

    it(':edge compares by base tag, and skips releases published before the build', () => {
        // Built 14 commits past v0.1.0 on 10-26: everything up to 0.1.2 (10-25)
        // predates the build.
        expect(on('v0.1.0-14-gab12cd3', '2026-10-26T00:00:00Z').latest).toBeNull();
        // Built on 10-22: 0.1.2 (10-25) is newer.
        expect(on('v0.1.0-14-gab12cd3', '2026-10-22T00:00:00Z').latest?.version).toBe('0.1.2');
        // Without a build time the base tag alone decides.
        expect(on('v0.1.0-14-gab12cd3').latest?.version).toBe('0.1.2');
    });

    it(':edge and other dev builds never get the red security notice', () => {
        // The fix may well be in the build already: fixes land on main first.
        expect(on('v0.1.0-14-gab12cd3').securityFixedIn).toBeNull();
        expect(on('0.1.0+ab12cd3').securityFixedIn).toBeNull();
        expect(on('0.1.0+ab12cd3').latest?.version).toBe('0.1.2');
    });

    it('a release build ignores the build time', () => {
        expect(on('v0.1.0', '2026-12-01T00:00:00Z').latest?.version).toBe('0.1.2');
    });

    it('an uncomparable build announces nothing', () => {
        expect(on('ab12cd3')).toEqual({
            latest: null,
            securityFixedIn: null,
            securityReviewed: null,
            comparable: false,
        });
    });

    it('a reviewed security release stops being red; a later one is red again', () => {
        const reviewed = new Set(['0.1.1']);
        const e = evaluateUpdate(RELEASES, parseRunningVersion('v0.1.0'), null, reviewed);
        expect(e.latest?.version).toBe('0.1.2');
        expect(e.securityFixedIn).toBeNull();
        expect(e.securityReviewed?.version).toBe('0.1.1');

        const later = evaluateUpdate(
            [...RELEASES, rel('0.1.3', { security: true })],
            parseRunningVersion('v0.1.0'),
            null,
            reviewed,
        );
        expect(later.securityFixedIn?.version).toBe('0.1.3');
    });

    it('reviewing the highest pending security release covers the older ones', () => {
        const releases = [...RELEASES, rel('0.1.3', { security: true })];
        const e = evaluateUpdate(releases, parseRunningVersion('v0.1.0'), null, new Set(['0.1.3']));
        expect(e.securityFixedIn).toBeNull();
        expect(e.securityReviewed?.version).toBe('0.1.3');
    });
});
