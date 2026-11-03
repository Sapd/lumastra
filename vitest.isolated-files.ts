/**
 * Unit test files that run in their own process (Vitest `isolate: true`), in the
 * `unit-isolated` project. Everything else runs in the `unit` project with
 * `isolate: false` (workers are reused across files; vitest.shared-setup.ts
 * resets module and process state between files). A file belongs here only
 * for a reason below. Do not list files that merely fail after a polluter: fix
 * or list the polluter.
 *
 * The list is computed from the files' source when the config loads, so a new
 * test that does one of these things is isolated without anyone remembering to
 * add it here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SCAN_DIRS = ['src', 'scripts', 'plugins', 'tests'];
const TEST_FILE = /\.(test|spec)\.(js|ts)$/;

const REASONS: ReadonlyArray<{ why: string; pattern: RegExp }> = [
    /**
     * Process time zone. These switch `process.env.TZ`; Node/V8 cache the zone and
     * its DST tables per process, and flipping it in a reused worker made
     * `new Date(...)` DST arithmetic wrong (a spring-forward test got hour 2
     * instead of 3). Passing `TZ` in a child process's env does not count.
     */
    { why: 'changes the process time zone', pattern: /process\.env\.TZ\s*=(?!=)/ },
    /**
     * Files that call `vi.resetModules()` and rebuild their own module graph. In a
     * reused worker, a dynamic import that is still in flight (from an earlier test
     * of the same file, or the last file) can land a module in the rebuilt graph
     * with the wrong env or mocks. Seen in oauth/rate-limit-strict-ip.test.ts
     * (client-ip built with an empty TRUSTED_PROXY_IPS although the test had stubbed
     * it) and watcher-native-status.test.ts (an env stub that was not undone); both
     * failed in roughly 1 of 10 full shared runs, and in none of 3 isolated runs.
     * Isolating the whole category is cheaper than finding which of them is next:
     * ~110 of 2,860 files, a few seconds of extra process starts.
     */
    { why: 'rebuilds its own module graph', pattern: /\bvi\.resetModules\s*\(/ },
];

function* testFiles(dir: string): Generator<string> {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* testFiles(path);
        else if (TEST_FILE.test(entry.name) && !entry.name.includes('.integration.')) yield path;
    }
}

/** Vitest `include` entries are globs: escape the glob characters of a real path. */
const asGlob = (path: string): string => path.replace(/[()[\]{}*?!]/g, '\\$&');

export function findIsolatedUnitFiles(root: string = ROOT): string[] {
    const found: string[] = [];
    for (const dir of SCAN_DIRS) {
        for (const file of testFiles(join(root, dir))) {
            const source = readFileSync(file, 'utf8');
            if (REASONS.some(({ pattern }) => pattern.test(source))) {
                found.push(relative(root, file).split('\\').join('/'));
            }
        }
    }
    return found.sort();
}

export const ISOLATED_UNIT_FILES: readonly string[] = findIsolatedUnitFiles().map(asGlob);
