/**
 * Unit test files that must run in their own process (Vitest `isolate: true`).
 *
 * Everything else runs in the `unit` project with `isolate: false` (workers are
 * reused across files; see vitest.shared-setup.ts for what is reset between
 * files). A file belongs here only when it POLLUTES process-wide state that the
 * setup file cannot restore, or cannot work next to other files in a worker.
 * One line of reason per entry. Do not list files that merely fail after a
 * polluter: fix or list the polluter.
 */
export const ISOLATED_UNIT_FILES: readonly string[] = [
    // Switch the process time zone (`process.env.TZ`). Node/V8 cache the zone and
    // DST tables per process; flipping it back and forth in a reused worker made
    // `new Date(...)` DST arithmetic wrong (seed 1: spring-forward test got hour 2).
    'src/lib/server/tasks/triggers.test.ts',
    'src/lib/shared/episode-availability.test.ts',
];
