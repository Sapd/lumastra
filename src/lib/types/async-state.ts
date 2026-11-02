// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Async State Types
 *
 * Discriminated union types for async operation tracking.
 * Replaces implicit state machines (multiple boolean flags) with explicit type-safe states.
 *
 * Invalid states become unrepresentable at the type level:
 * - Can't have loading=true && error=true
 * - Can't have data without success status
 * - Can't have stale request keys with new data
 */

/**
 * Discriminated union for async operation state.
 * @template T The type of data returned on success
 */
export type AsyncState<T> =
    | { status: 'idle' }
    | { status: 'loading'; requestKey?: string }
    | { status: 'success'; data: T; requestKey?: string }
    | { status: 'error'; error: Error };

// ============================================================================
// Type Guards
// ============================================================================

export function isIdle<T>(state: AsyncState<T>): state is { status: 'idle' } {
    return state.status === 'idle';
}

export function isLoading<T>(
    state: AsyncState<T>,
): state is { status: 'loading'; requestKey?: string } {
    return state.status === 'loading';
}

export function isSuccess<T>(
    state: AsyncState<T>,
): state is { status: 'success'; data: T; requestKey?: string } {
    return state.status === 'success';
}

export function isError<T>(state: AsyncState<T>): state is { status: 'error'; error: Error } {
    return state.status === 'error';
}

// ============================================================================
// Data Extractors
// ============================================================================

/**
 * Safely extract data from AsyncState with fallback
 */
export function getDataOr<T>(state: AsyncState<T>, fallback: T): T {
    return state.status === 'success' ? state.data : fallback;
}

/**
 * Extract data or undefined (for optional data)
 */
export function getData<T>(state: AsyncState<T>): T | undefined {
    return state.status === 'success' ? state.data : undefined;
}

/**
 * Extract error or undefined
 */
export function getError<T>(state: AsyncState<T>): Error | undefined {
    return state.status === 'error' ? state.error : undefined;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an idle state
 */
export function idle<T>(): AsyncState<T> {
    return { status: 'idle' };
}

/**
 * Create a loading state with optional request key for deduplication
 */
export function loading<T>(requestKey?: string): AsyncState<T> {
    return requestKey ? { status: 'loading', requestKey } : { status: 'loading' };
}

/**
 * Create a success state with data and optional request key
 */
export function success<T>(data: T, requestKey?: string): AsyncState<T> {
    return requestKey ? { status: 'success', data, requestKey } : { status: 'success', data };
}

/**
 * Create an error state
 */
export function error<T>(err: Error): AsyncState<T> {
    return { status: 'error', error: err };
}

/**
 * Create an error state from unknown error (useful in catch blocks)
 */
export function errorFromUnknown<T>(err: unknown): AsyncState<T> {
    if (err instanceof Error) {
        return { status: 'error', error: err };
    }
    return { status: 'error', error: new Error(String(err)) };
}
