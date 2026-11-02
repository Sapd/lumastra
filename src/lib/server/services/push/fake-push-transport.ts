// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * In-memory transport for tests. Never reaches the network.
 *
 * Lives in `src/` rather than a test directory because the delivery-pass
 * integration tests import it, and those run under the integration vitest config
 * with a different root.
 *
 * @module services/push/fake-push-transport
 */

import type { PushRequest, PushResult, PushTokenStatus, PushTransport } from './push-transport.js';

export class FakePushTransport implements PushTransport {
    readonly calls: PushRequest[] = [];
    private resultFn: (token: string) => PushTokenStatus = () => 'ok';
    private error: Error | null = null;

    setResults(fn: (token: string) => PushTokenStatus): void {
        this.resultFn = fn;
    }

    setError(err: Error | null): void {
        this.error = err;
    }

    async send(req: PushRequest): Promise<PushResult[]> {
        this.calls.push(req);
        if (this.error) throw this.error;
        return req.tokens.map((token) => ({ token, status: this.resultFn(token) }));
    }
}
