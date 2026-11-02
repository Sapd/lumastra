// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    ISOLATION_WORKER_ENV_MARKER,
    IsolationWorkerKeyAccessError,
    callerFrames,
    isIsolationWorker,
} from './isolation-context.js';

describe('isIsolationWorker', () => {
    const marked = { [ISOLATION_WORKER_ENV_MARKER]: '1' };

    it('is true only for a non-main thread carrying the marker', () => {
        expect(isIsolationWorker(marked, false)).toBe(true);
    });

    it('never treats a main thread as isolated, even with the marker (dedicated worker container, stray env)', () => {
        expect(isIsolationWorker(marked, true)).toBe(false);
    });

    it('does not treat other worker threads (no marker) as isolated', () => {
        expect(isIsolationWorker({}, false)).toBe(false);
        expect(isIsolationWorker({ [ISOLATION_WORKER_ENV_MARKER]: '0' }, false)).toBe(false);
    });
});

describe('IsolationWorkerKeyAccessError', () => {
    it('names its caller in the message (the host log carries only the message)', () => {
        function askForTheKeyFromHere(): never {
            throw new IsolationWorkerKeyAccessError('The master key');
        }
        let msg = '';
        try {
            askForTheKeyFromHere();
        } catch (err) {
            msg = (err as Error).message;
        }
        expect(msg).toContain('[called from: ');
        expect(msg).toContain('askForTheKeyFromHere');
    });

    it('callerFrames skips the error constructor and keeps at most N frames', () => {
        const stack = [
            'Error',
            '    at new IsolationWorkerKeyAccessError (a.js:1:1)',
            '    at resolveMasterKey (b.js:2:2)',
            '    at derivedJwtSecret (c.js:3:3)',
            '    at get JWT_SECRET (c.js:4:4)',
        ].join('\n');
        expect(callerFrames(stack, 2)).toBe(
            'resolveMasterKey (b.js:2:2) <- derivedJwtSecret (c.js:3:3)',
        );
        expect(callerFrames(undefined)).toBe('');
    });
});
