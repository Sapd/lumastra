// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Version arithmetic for the Lumastra update check. Pure: no I/O, no config.
 *
 * The running version is a `git describe` string (see `build-info.ts`), not a
 * bare semver, so it comes in three shapes:
 *
 *   v0.2.0             a release build (image tag `:0.2.0`, `:latest`)
 *   v0.2.0-rc.1        a pre-release build
 *   v0.2.0-14-gab12cd  a build 14 commits past v0.2.0 — the `:edge` image,
 *                      which follows main, or a local dev build
 *
 * plus `-dirty`, and the fallbacks `0.1.0+ab12cd` (package.json + sha) and a
 * bare sha or `unknown` when nothing describes the build. The last two have no
 * version to compare and never produce a notice.
 *
 * `:edge` decision: a describe-with-distance build (and the `+sha` fallback)
 * is a DEV build. It compares by its base tag, only counts a release as newer
 * when the release was published after the build, and is never told about a
 * security release in red. The reason is that neither the tag nor the dates
 * say whether the build contains a fix: fixes land on main first, so an edge
 * build is usually AHEAD of the release that later ships its fix, yet that
 * release is published after the build and names a higher version. A red,
 * undismissable notice on a build that already has the fix would teach people
 * to switch the check off. Dev builds therefore get the quiet notice only;
 * release builds (`:latest`, `:X.Y.Z`) get the red one.
 */

export interface Semver {
    major: number;
    minor: number;
    patch: number;
    /** Dot-separated pre-release identifiers; empty for a release. */
    prerelease: string[];
}

export interface RunningVersion {
    /** The comparable version, or null when the build has none (bare sha, unknown). */
    semver: Semver | null;
    /** Commits past the base tag (`-N-g<sha>`): an `:edge` or dev build. */
    distance: number;
    /** `:edge`, a local build, or the package.json + sha fallback — not a release. */
    devBuild: boolean;
    raw: string;
}

const SEMVER_RE =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string with an optional leading `v`. Null when it is not one. */
export function parseSemver(input: string): Semver | null {
    const m = SEMVER_RE.exec(input.trim());
    if (!m) return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        prerelease: m[4] ? m[4].split('.') : [],
    };
}

function compareIdentifier(a: string, b: string): number {
    const an = /^\d+$/.test(a);
    const bn = /^\d+$/.test(b);
    if (an && bn) return Number(a) - Number(b);
    // Numeric identifiers sort below alphanumeric ones (semver §11.4.3).
    if (an) return -1;
    if (bn) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence. Returns <0, 0 or >0. Build metadata is ignored. */
export function compareSemver(a: Semver, b: Semver): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    // A release outranks any of its pre-releases.
    if (a.prerelease.length === 0 || b.prerelease.length === 0) {
        return b.prerelease.length - a.prerelease.length;
    }
    const n = Math.max(a.prerelease.length, b.prerelease.length);
    for (let i = 0; i < n; i++) {
        if (a.prerelease[i] === undefined) return -1;
        if (b.prerelease[i] === undefined) return 1;
        const c = compareIdentifier(a.prerelease[i], b.prerelease[i]);
        if (c !== 0) return c;
    }
    return 0;
}

export function formatSemver(v: Semver): string {
    const core = `${v.major}.${v.minor}.${v.patch}`;
    return v.prerelease.length > 0 ? `${core}-${v.prerelease.join('.')}` : core;
}

/** Interpret the running build's `git describe` / fallback version string. */
export function parseRunningVersion(raw: string): RunningVersion {
    let s = raw.trim().replace(/-dirty$/, '');
    let distance = 0;
    const describe = /-(\d+)-g[0-9a-f]{4,40}$/.exec(s);
    if (describe) {
        distance = Number(describe[1]);
        s = s.slice(0, describe.index);
    }
    // `0.1.0+ab12cd3` is the package.json fallback with a commit attached: a
    // build of SOME commit, not the 0.1.0 release.
    const devBuild = distance > 0 || s.includes('+');
    return { semver: parseSemver(s), distance, devBuild, raw };
}

/** A release as the check stores it — only what the notice and comparison need. */
export interface ReleaseInfo {
    version: string;
    url: string;
    publishedAt: string | null;
    security: boolean;
    prerelease: boolean;
}

/**
 * Whether a release announces a security fix.
 *
 * Two signals, both readable from the release itself with no extra request:
 * a line that is exactly `Security: yes` (case-insensitive; markdown emphasis,
 * a list bullet or a quote marker around it tolerated — `**Security:** yes`),
 * or a link to one of THIS repository's GitHub Security Advisories, which is
 * how a release points at the advisory it fixes. A bare `GHSA-…` id does not
 * count: release notes may mention an advisory they are not fixing.
 */
export function isSecurityRelease(body: string | null | undefined): boolean {
    if (!body) return false;
    for (const line of body.split(/\r?\n/)) {
        const plain = line
            .replace(/^\s*(?:>\s*)*(?:[-*+]\s+)?/, '')
            .replace(/[*_`]/g, '')
            .trim();
        if (/^security\s*:\s*yes\.?$/i.test(plain)) return true;
    }
    return /github\.com\/Sapd\/lumastra\/security\/advisories\/GHSA(-[23456789cfghjmpqrvwx]{4}){3}\b/i.test(
        body,
    );
}

export interface UpdateEvaluation {
    /** Newest applicable release that is newer than the running build. */
    latest: ReleaseInfo | null;
    /**
     * Highest security release newer than the running build. The red notice
     * stays until the install reaches this version (or anything above it).
     */
    securityFixedIn: ReleaseInfo | null;
    /**
     * Highest security release an admin marked as reviewed ("does not apply /
     * mitigated") that would otherwise have been `securityFixedIn`. It no
     * longer turns the notice red; the page says so.
     */
    securityReviewed: ReleaseInfo | null;
    /** False when the running build has no comparable version. */
    comparable: boolean;
}

/**
 * Decide what, if anything, to announce for this build.
 *
 * Pre-releases only count when the build itself runs one: someone on
 * `v0.3.0-rc.1` wants `-rc.2`, someone on `v0.2.0` does not.
 */
export function evaluateUpdate(
    releases: ReleaseInfo[],
    running: RunningVersion,
    buildTime?: string | null,
    /** Security releases an admin marked as reviewed; see `securityReviewed`. */
    reviewedSecurity: ReadonlySet<string> = new Set(),
): UpdateEvaluation {
    const current = running.semver;
    if (!current) {
        return { latest: null, securityFixedIn: null, securityReviewed: null, comparable: false };
    }
    const includePrereleases = current.prerelease.length > 0;
    const built = running.devBuild && buildTime ? Date.parse(buildTime) : NaN;

    const newer: Array<{ release: ReleaseInfo; semver: Semver }> = [];
    for (const release of releases) {
        const semver = parseSemver(release.version);
        if (!semver) continue;
        if ((release.prerelease || semver.prerelease.length > 0) && !includePrereleases) continue;
        if (compareSemver(semver, current) <= 0) continue;
        if (Number.isFinite(built) && release.publishedAt) {
            const published = Date.parse(release.publishedAt);
            if (Number.isFinite(published) && published <= built) continue;
        }
        newer.push({ release, semver });
    }
    newer.sort((a, b) => compareSemver(b.semver, a.semver));
    // Dev builds never go red; see the header.
    const security = running.devBuild ? [] : newer.filter((n) => n.release.security);
    // Reviewing V covers every security release up to V: the page offers the
    // highest pending one, and an admin who checked that one must not be sent
    // round again for an older fix it includes.
    const reviewedMax = [...reviewedSecurity]
        .map((v) => parseSemver(v))
        .filter((v): v is Semver => v !== null)
        .reduce<Semver | null>((max, v) => (!max || compareSemver(v, max) > 0 ? v : max), null);
    const isReviewed = (s: Semver): boolean =>
        reviewedMax !== null && compareSemver(s, reviewedMax) <= 0;
    return {
        latest: newer[0]?.release ?? null,
        securityFixedIn: security.find((n) => !isReviewed(n.semver))?.release ?? null,
        securityReviewed: security.find((n) => isReviewed(n.semver))?.release ?? null,
        comparable: true,
    };
}
