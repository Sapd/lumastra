// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dockerfile supply-chain fetch guard.
 *
 * Two patterns get flagged, both of them "run whatever a remote server hands
 * back, unverified, as root during the image build":
 *
 *   1. `curl ... | tar` / `curl ... | bash` (a direct pipe from a network
 *      fetch straight into extraction or a shell — nothing in between could
 *      have verified the bytes). The fix is NOT to add a check after the
 *      fact (you can't verify a stream after it's already been consumed) —
 *      it's to download to a file, verify a pinned digest with
 *      `sha256sum -c`, and only then extract/run it. A RUN block containing
 *      BOTH a `curl | tar`/`curl | bash` pipe AND a `sha256sum -c` is still
 *      flagged: the safe pattern never produces that pipe form in the first
 *      place (see the Essentia block in Dockerfile for the
 *      download-then-verify shape this guard expects instead).
 *   2. `npm install -g <pkg>` / `npx --yes <pkg>` with no `@<version>` — an
 *      unpinned global/ephemeral install re-resolves to whatever is newest on
 *      the registry at build time.
 *
 * Run: `node scripts/check-dockerfile-fetches.mjs [path]` (default:
 * `Dockerfile` in the cwd; exit 1 on any violation). Wired into
 * `npm run lint:dockerfile-fetches` — deliberately NOT part of `lint`'s
 * parallel chain.
 */

import { readFileSync } from 'node:fs';

const DEFAULT_DOCKERFILE = 'Dockerfile';

// [\s\S] (not '.') so the pipe target can be on a following physical line —
// a `curl ... \` line continuation followed by `| tar ...` is the common
// real shape (see Dockerfile's former Essentia block) and must still match.
const CURL_PIPE_TAR_RE = /\bcurl\b[\s\S]*?\|\s*tar\b/;
const CURL_PIPE_BASH_RE = /\bcurl\b[\s\S]*?\|\s*(?:ba)?sh\b/;
const SHA256SUM_C_RE = /\bsha256sum\s+-c\b/;
// `npm install [-g|--global] <pkg>` (no @version) or `npx --yes <pkg>` (no
// @version). A scoped package (@org/pkg) has its own leading '@' — only a
// SECOND '@' (the version separator) satisfies the "pinned" check, so we
// look for '@' after the package name's first character.
const NPM_INSTALL_G_RE = /\bnpm\s+install\s+(?:-g|--global)\s+([^\s&|;]+)/g;
const NPX_YES_RE = /\bnpx\s+--yes\s+([^\s&|;]+)/g;

function isPinned(pkgSpec) {
    // Strip a leading scope ('@org/pkg') before looking for the '@version'
    // separator, so '@org/pkg' alone (no version) is correctly NOT pinned.
    const rest = pkgSpec.startsWith('@') ? pkgSpec.slice(1) : pkgSpec;
    return rest.includes('@');
}

/** Split a Dockerfile into logical instructions, joining `\`-continued lines. */
function joinContinuations(content) {
    const rawLines = content.split('\n');
    const blocks = []; // { text, startLine (1-indexed) }
    let current = null;
    let currentStart = 0;
    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (current === null) {
            if (line.trim() === '' || line.trim().startsWith('#')) continue;
            current = line;
            currentStart = i + 1;
        } else {
            current += '\n' + line;
        }
        // A line ending in a lone backslash (ignoring trailing whitespace)
        // continues onto the next line; otherwise this instruction is done.
        if (/\\\s*$/.test(line)) continue;
        blocks.push({ text: current, startLine: currentStart });
        current = null;
    }
    if (current !== null) blocks.push({ text: current, startLine: currentStart });
    return blocks;
}

/**
 * Scan Dockerfile content for unverified-fetch / unpinned-install violations.
 * Returns [{ line, kind, detail }].
 */
function findViolations(content) {
    const violations = [];
    for (const block of joinContinuations(content)) {
        if (!/^\s*RUN\b/.test(block.text)) continue;

        const hasChecksum = SHA256SUM_C_RE.test(block.text);
        if (CURL_PIPE_TAR_RE.test(block.text) && !hasChecksum) {
            violations.push({
                line: block.startLine,
                kind: 'unverified-curl-pipe-tar',
                detail: 'curl piped directly into tar with no sha256sum -c in the same RUN block',
            });
        }
        if (CURL_PIPE_BASH_RE.test(block.text) && !hasChecksum) {
            violations.push({
                line: block.startLine,
                kind: 'unverified-curl-pipe-bash',
                detail: 'curl piped directly into a shell with no sha256sum -c in the same RUN block',
            });
        }

        for (const re of [NPM_INSTALL_G_RE, NPX_YES_RE]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(block.text))) {
                const pkgSpec = m[1];
                if (!isPinned(pkgSpec)) {
                    // Which physical line within the block actually has the match.
                    const before = block.text.slice(0, m.index);
                    const line = block.startLine + (before.match(/\n/g) ?? []).length;
                    violations.push({
                        line,
                        kind:
                            re === NPM_INSTALL_G_RE ? 'unpinned-npm-install-g' : 'unpinned-npx-yes',
                        detail: `'${pkgSpec}' has no @version pin`,
                    });
                }
            }
        }
    }
    return violations;
}

function main(argv) {
    const path = argv[2] ?? DEFAULT_DOCKERFILE;
    let content;
    try {
        content = readFileSync(path, 'utf8');
    } catch (err) {
        console.error(`check-dockerfile-fetches: cannot read '${path}': ${err.message}`);
        return 1;
    }
    const violations = findViolations(content);
    if (violations.length === 0) {
        console.log(
            `check-dockerfile-fetches: ${path} has no unverified fetches or unpinned installs.`,
        );
        return 0;
    }
    console.error(`check-dockerfile-fetches: ${violations.length} violation(s) in ${path}:`);
    for (const v of violations) {
        console.error(`  ${path}:${v.line}  [${v.kind}] ${v.detail}`);
    }
    return 1;
}

// Only run when invoked directly, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    process.exit(main(process.argv));
}

export { main, findViolations };
