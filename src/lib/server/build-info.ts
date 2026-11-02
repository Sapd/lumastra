// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build identity for the running app. `version` is the `git describe` string
 * (clean tag = official release; `-N-g<sha>` suffix = dev build off a tag).
 */
export interface BuildInfo {
    version: string;
    commit: string;
    commitShort: string;
    buildTime: string;
    branch: string;
}

export interface DeriveBuildInfoOptions {
    /** Environment map (real: `process.env`). Explicit values win over git. */
    env: Record<string, string | undefined>;
    /** Runs `git <args>`, returns trimmed stdout, or '' on any failure. Injected for testability. */
    runGit: (args: string) => string;
    /** package.json version, used only when neither env nor git yields a version. */
    pkgVersion?: string;
    /** ISO timestamp used for build time when no APP_BUILD_TIME env is set. */
    now?: string;
}

/**
 * Resolve build identity in priority order: explicit env var → git → fallback.
 * Empty-string env values are treated as unset so an empty build-arg never wins.
 *
 * `git describe --always` returns a bare short SHA even when there is no tag
 * to describe from, so the `pkgVersion` branch below is reached only when git
 * itself is entirely unavailable (e.g. a Docker build, where `.git` is
 * excluded from the build context by `.dockerignore`) — never merely "no tag
 * reachable". That branch appends a `+<shortSha>` build-metadata suffix
 * (semver-style) when a commit is independently known (e.g. passed via
 * APP_COMMIT/APP_COMMIT_SHORT even though describe/tags are not), so the
 * fallback reads e.g. `0.1.3+a1b2c3d` instead of a bare, un-traceable version.
 */
export function deriveBuildInfo({
    env,
    runGit,
    pkgVersion = 'unknown',
    now = '',
}: DeriveBuildInfoOptions): BuildInfo {
    const commit = env.APP_COMMIT || runGit('rev-parse HEAD') || '';
    const commitShort =
        env.APP_COMMIT_SHORT ||
        runGit('rev-parse --short HEAD') ||
        (commit ? commit.slice(0, 9) : '');
    const fallbackVersion = pkgVersion
        ? commitShort
            ? `${pkgVersion}+${commitShort}`
            : pkgVersion
        : 'unknown';
    const version =
        env.APP_VERSION ||
        runGit('describe --tags --always --dirty --match "v*"') ||
        fallbackVersion;
    const buildTime = env.APP_BUILD_TIME || now || '';
    const branch = env.APP_BRANCH || runGit('rev-parse --abbrev-ref HEAD') || '';
    return { version, commit, commitShort, buildTime, branch };
}
