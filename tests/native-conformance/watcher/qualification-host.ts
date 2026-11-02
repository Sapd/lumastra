// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { nativeWatcherPolicy } from '../../../src/lib/server/utils/media-file-kinds.js';
import { NativeWatcherProcess } from '../../../src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-host.js';
// IPC and event collection exercise the production native host.
interface Init {
    paths: string[];
    binaryPath: string;
    faultLateCallback?: boolean;
}

function send(message: object): void {
    if (process.connected) process.send?.({ ...message, receivedAtMs: performance.now() });
}

const init = JSON.parse(process.argv[2]) as Init;
const callbacks = {
    paths: init.paths,
    onReady: (): void => send({ type: 'ready' }),
    onEvent: (event: string, path: string): void => send({ type: 'event', event, path }),
    onError: (error: unknown): void => send({ type: 'error', error }),
};
const watcher = new NativeWatcherProcess({
    ...callbacks,
    policy: nativeWatcherPolicy({
        containmentRoots: init.paths,
        sensitivePrefixes: ['/proc', '/sys', '/dev', '/etc'],
    }),
    binaryPath: init.binaryPath,
    onRescan: (reason: string): void => send({ type: 'rescan', reason }),
});

let closing = false;
async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
        await watcher.close();
        // Explicit qualification-only negative control: this callback occurs
        // after the quiet window, just before the IPC channel finishes.
        if (init.faultLateCallback)
            send({ type: 'event', event: 'add', path: `${init.paths[0]}/fault-late.mkv` });
        send({ type: 'closed' });
        process.disconnect?.();
    } catch (error) {
        send({ type: 'error', error: String(error) });
        process.exitCode = 1;
        process.disconnect?.();
    }
}
process.on('message', (message: unknown) => {
    if (message === 'close') void close();
});
process.on('disconnect', () => {
    void close();
});
watcher.start();
