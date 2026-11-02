// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { deriveBuildInfo } from './build-info';

const noGit = (): string => '';

describe('deriveBuildInfo', () => {
    it('prefers explicit env vars over git', () => {
        const info = deriveBuildInfo({
            env: {
                APP_VERSION: 'v0.1.0',
                APP_COMMIT: 'abcdef1234567890',
                APP_COMMIT_SHORT: 'abcdef123',
                APP_BUILD_TIME: '2026-07-11T00:00:00Z',
                APP_BRANCH: 'stable',
            },
            runGit: () => 'SHOULD_NOT_BE_USED',
        });
        expect(info).toEqual({
            version: 'v0.1.0',
            commit: 'abcdef1234567890',
            commitShort: 'abcdef123',
            buildTime: '2026-07-11T00:00:00Z',
            branch: 'stable',
        });
    });

    it('falls back to git when env is empty', () => {
        const runGit = (args: string): string => {
            if (args.startsWith('describe')) return 'v0.1.0-5-ge6f5150';
            if (args === 'rev-parse HEAD') return 'e6f5150db0000000';
            if (args === 'rev-parse --short HEAD') return 'e6f5150';
            if (args === 'rev-parse --abbrev-ref HEAD') return 'main';
            return '';
        };
        const info = deriveBuildInfo({ env: {}, runGit, now: '2026-07-11T09:00:00Z' });
        expect(info.version).toBe('v0.1.0-5-ge6f5150');
        expect(info.commit).toBe('e6f5150db0000000');
        expect(info.commitShort).toBe('e6f5150');
        expect(info.buildTime).toBe('2026-07-11T09:00:00Z');
        expect(info.branch).toBe('main');
    });

    it('derives short SHA from full commit when git short is unavailable', () => {
        const info = deriveBuildInfo({
            env: { APP_COMMIT: 'abcdef1234567890' },
            runGit: noGit,
        });
        expect(info.commitShort).toBe('abcdef123'); // 9 chars
    });

    it('falls back to pkgVersion, then "unknown", when there is no git', () => {
        expect(deriveBuildInfo({ env: {}, runGit: noGit, pkgVersion: '0.0.0' }).version).toBe(
            '0.0.0',
        );
        expect(deriveBuildInfo({ env: {}, runGit: noGit }).version).toBe('unknown');
    });

    it('appends a +<shortSha> suffix to the pkgVersion fallback when a commit is known', () => {
        // No git at all (e.g. a Docker build with .git excluded from the context), but
        // the commit was passed through separately (APP_COMMIT/APP_COMMIT_SHORT env).
        const info = deriveBuildInfo({
            env: { APP_COMMIT_SHORT: 'a1b2c3d' },
            runGit: noGit,
            pkgVersion: '0.1.3',
        });
        expect(info.version).toBe('0.1.3+a1b2c3d');
        expect(info.commitShort).toBe('a1b2c3d');
    });

    it('does not append a suffix to the pkgVersion fallback when no commit is known', () => {
        const info = deriveBuildInfo({ env: {}, runGit: noGit, pkgVersion: '0.1.3' });
        expect(info.version).toBe('0.1.3');
    });

    it('never appends a suffix on the proper git-describe path, even with a known commit', () => {
        const runGit = (args: string): string => {
            if (args.startsWith('describe')) return 'v0.1.3';
            if (args === 'rev-parse --short HEAD') return 'a1b2c3d';
            return '';
        };
        const info = deriveBuildInfo({ env: {}, runGit, pkgVersion: '0.1.3' });
        expect(info.version).toBe('v0.1.3');
    });

    it('treats empty-string env vars as unset (empty build-arg must not win)', () => {
        const info = deriveBuildInfo({
            env: { APP_VERSION: '', APP_COMMIT: '' },
            runGit: (args) => (args.startsWith('describe') ? 'v0.2.0' : ''),
        });
        expect(info.version).toBe('v0.2.0');
    });
});
