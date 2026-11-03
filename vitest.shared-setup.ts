/**
 * Setup file of the shared (`isolate: false`) unit project.
 *
 * With `isolate: false` Vitest keeps one worker process for many test files and
 * does NOT do what `isolate: true` does before every file: clear the mock
 * registry and the module graph. So module-level state (a mocked database
 * module, a singleton, a cached config) and process-wide state (env, globals,
 * fake timers, process listeners) leaked from one file into the next one in the
 * same worker, and which files shared a worker changed with every file order.
 *
 * This file runs before every test file (setup files are re-imported per file
 * because we invalidate our own module below) and
 *   1. does what `isolate: true` does: drops all mocks registrations and evaluated
 *      modules (node_modules packages stay cached in Node itself, which is where
 *      most of the speed-up over one process per file comes from), and
 *   2. snapshots process-wide state now and restores it after the file.
 */
import { afterAll, vi } from 'vitest';

interface WorkerLike {
    evaluatedModules?: {
        idToModuleMap: Map<
            string,
            { promise?: unknown; exports?: unknown; evaluated?: boolean; importers: Set<unknown> }
        >;
    };
}

const g = globalThis as unknown as Record<string, unknown> & {
    __vitest_worker__?: WorkerLike;
    __vitest_mocker__?: { reset?: () => void };
};

// These are Vitest internals (Vitest 5 base runner: `moduleRunner.mocker?.reset()`
// and `resetModules(workerState.evaluatedModules)`). If an upgrade renames them,
// the reset below would silently do nothing and files would leak into each other
// again, so fail every file loudly instead.
if (
    typeof g.__vitest_mocker__?.reset !== 'function' ||
    !(g.__vitest_worker__?.evaluatedModules?.idToModuleMap instanceof Map)
) {
    throw new Error(
        'vitest.shared-setup.ts: Vitest internals __vitest_mocker__.reset / ' +
            '__vitest_worker__.evaluatedModules.idToModuleMap are gone (Vitest upgrade?). ' +
            'Update the per-file reset here, or set isolate: true for the unit project.',
    );
}

// Work the previous file left in flight must not run while this file's modules
// are being reset and mocked. The case that bites is an un-awaited dynamic
// `import()` (or a promise chain that reaches one) that is still loading modules
// when the next file starts: it lands real modules in the fresh graph, ahead of
// the new file's vi.mock, and the new file then gets modules wired to the wrong
// (or the real) dependencies. Seen as: a mocked config the module under test never
// saw, a permissions cache behind its own mock, settings that read as empty.
// So: a few macrotask turns, then wait (bounded) until the module runner has no
// import in flight. Modules of this setup file itself are always "in flight" here.
const importsInFlight = (): number => {
    let pending = 0;
    g.__vitest_worker__?.evaluatedModules?.idToModuleMap.forEach((node, path) => {
        if (node.promise && !node.evaluated && !path.includes('vitest.shared-setup')) pending++;
    });
    return pending;
};
const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    const deadline = Date.now() + 5000;
    while (importsInFlight() > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
await settle();

// --- 1. what `isolate: true` does before each file (vitest base runner) ---------
g.__vitest_mocker__?.reset?.();
const SKIP = [/\/vitest\/dist\//, /vitest-virtual-\w+\/dist/, /@vitest\/dist/];
g.__vitest_worker__?.evaluatedModules?.idToModuleMap.forEach((node, path) => {
    if (SKIP.some((re) => re.test(path))) return;
    node.promise = undefined;
    node.exports = undefined;
    node.evaluated = false;
    node.importers.clear();
});

// --- 2. process-wide state, restored after the file ----------------------------
const envBefore = { ...process.env };
const globalKeysBefore = new Map<PropertyKey, PropertyDescriptor>();
for (const key of Reflect.ownKeys(globalThis)) {
    const d = Object.getOwnPropertyDescriptor(globalThis, key);
    if (d) globalKeysBefore.set(key, d);
}
const keepNew = (key: PropertyKey) =>
    typeof key === 'string' && (key.startsWith('__vitest') || key.startsWith('__coverage__'));
const cwdBefore = process.cwd();
const exitCodeBefore = process.exitCode;
const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');

// BroadcastChannel is process-wide: same-named channels in one process hear each
// other. A channel one file forgets to close would answer another file's
// coordinator (music-tab-sync.test.ts: a lone tab suddenly found an owner), so
// every channel opened during a file is closed after it.
const OriginalBroadcastChannel = globalThis.BroadcastChannel;
const openChannels = new Set<BroadcastChannel>();
if (OriginalBroadcastChannel) {
    globalThis.BroadcastChannel = class extends OriginalBroadcastChannel {
        constructor(name: string) {
            super(name);
            openChannels.add(this);
        }
    } as typeof BroadcastChannel;
}

// Timers a file leaves running (a service's cleanup interval, a retry timeout)
// would fire inside a later file against that file's mocks: a leaked
// FFmpegTranscodeService interval threw "cleanupSessionDirectory is not a function"
// as an unhandled rejection in whatever file ran next, failing the whole run
// with all tests green. Every timer started during a file is cleared after it.
const OriginalSetInterval = globalThis.setInterval;
const OriginalSetTimeout = globalThis.setTimeout;
const liveTimers = new Set<ReturnType<typeof setTimeout>>();
globalThis.setInterval = Object.assign(
    ((...args: Parameters<typeof setInterval>) => {
        const timer = OriginalSetInterval(...args);
        liveTimers.add(timer);
        return timer;
    }) as typeof setInterval,
    OriginalSetInterval,
);
globalThis.setTimeout = Object.assign(
    ((callback: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
        if (typeof callback !== 'function') return OriginalSetTimeout(callback, ms, ...rest);
        const timer: ReturnType<typeof setTimeout> = OriginalSetTimeout(
            (...a: unknown[]) => {
                liveTimers.delete(timer);
                return callback(...a);
            },
            ms,
            ...rest,
        );
        liveTimers.add(timer);
        return timer;
    }) as typeof setTimeout,
    OriginalSetTimeout,
);

const listenersBefore = new Map<string | symbol, Array<(...args: never[]) => void>>();
for (const ev of process.eventNames()) listenersBefore.set(ev, [...process.listeners(ev as never)]);

afterAll(async () => {
    for (const channel of openChannels) {
        try {
            channel.close();
        } catch {
            /* already closed */
        }
    }
    openChannels.clear();
    vi.useRealTimers();
    for (const timer of liveTimers) clearTimeout(timer);
    liveTimers.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();

    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    for (const [key, value] of Object.entries(envBefore))
        if (process.env[key] !== value) process.env[key] = value;

    for (const key of Reflect.ownKeys(globalThis)) {
        if (globalKeysBefore.has(key) || keepNew(key)) continue;
        try {
            delete (globalThis as Record<PropertyKey, unknown>)[key as string];
        } catch {
            /* non-configurable */
        }
    }
    for (const [key, desc] of globalKeysBefore) {
        const now = Object.getOwnPropertyDescriptor(globalThis, key);
        if (!now || now.value !== desc.value || now.get !== desc.get || now.set !== desc.set) {
            try {
                Object.defineProperty(globalThis, key, desc);
            } catch {
                /* non-configurable */
            }
        }
    }

    for (const ev of process.eventNames()) {
        const before = listenersBefore.get(ev) ?? [];
        for (const fn of process.listeners(ev as never)) {
            if (!before.includes(fn)) process.removeListener(ev as never, fn as never);
        }
    }
    if (process.cwd() !== cwdBefore) process.chdir(cwdBefore);
    process.exitCode = exitCodeBefore;
    if (
        platformDesc &&
        Object.getOwnPropertyDescriptor(process, 'platform')?.value !== platformDesc.value
    ) {
        Object.defineProperty(process, 'platform', platformDesc);
    }
    await settle();
});
