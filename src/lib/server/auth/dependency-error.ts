// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// No HTTP imports: the startup migration runner and plugin workers load this
// without SvelteKit (pruned from the production image).
import { TimeoutError as ValkeyTimeoutError } from '@valkey/valkey-glide';

/** Authentication could not be checked. This is never an invalid credential verdict. */
export class AuthDependencyUnavailableError extends Error {
    constructor(cause?: unknown) {
        super('Authentication temporarily unavailable', { cause });
        this.name = 'AuthDependencyUnavailableError';
    }
}

/** Recognize infrastructure failures without turning malformed credentials or bugs into outages. */
export function isDependencyError(error: unknown): boolean {
    const seen = new Set<unknown>();
    const visit = (value: unknown): boolean => {
        if (!value || typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        if (value instanceof AuthDependencyUnavailableError) return true;
        const { code, name, cause } = value as { code?: unknown; name?: unknown; cause?: unknown };
        if (
            typeof code === 'string' &&
            (code.startsWith('CONNECTION_') ||
                code === 'CONNECT_TIMEOUT' ||
                code === '25006' ||
                /^(08|53)[0-9A-Z]{3}$/.test(code) ||
                /^57P0[0-9A-Z]$/.test(code) ||
                [
                    'ECONNREFUSED',
                    'ETIMEDOUT',
                    'ECONNRESET',
                    'EPIPE',
                    'EAI_AGAIN',
                    'ENOTFOUND',
                ].includes(code))
        )
            return true;
        // valkey-glide's connection/closing/request timeout errors have no Node errno.
        if (
            name === 'ConnectionError' ||
            name === 'ClosingError' ||
            value instanceof ValkeyTimeoutError
        )
            return true;
        if (
            name === 'RequestError' &&
            value instanceof Error &&
            /^(?:LOADING|READONLY|BUSY)(?:\s|$)/.test(value.message)
        )
            return true;
        if (value instanceof AggregateError && value.errors.some(visit)) return true;
        return visit(cause);
    };
    return visit(error);
}
