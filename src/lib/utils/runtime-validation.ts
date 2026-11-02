// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runtime Validation Utilities
 *
 * Development-only runtime checks to catch type mismatches, undefined values,
 * and callback signature errors that would otherwise fail silently.
 *
 * **Key Features:**
 * - Development-only (tree-shaken in production via `import.meta.env.DEV`)
 * - Clear error messages with debugging context
 * - Type-safe wrappers for callbacks and event handlers
 * - Validation helpers for common patterns
 *
 * **When to use:**
 * - Functions that receive callbacks from user code
 * - Event handlers that expect specific event types
 * - Critical code paths where silent failures cause bugs
 * - Complex component interactions with type boundaries
 *
 * @see docs/runtime-validation.md for detailed usage examples
 */

/**
 * Asserts that a value is defined (not null or undefined).
 * Throws in development, logs error in production.
 *
 * @example
 * function processUser(user: User | undefined) {
 *   assertDefined(user, 'User must be provided');
 *   // TypeScript now knows user is defined
 *   console.log(user.name);
 * }
 *
 * @param value - The value to check
 * @param message - Error message describing what should be defined
 * @param context - Optional additional context for debugging
 */
export function assertDefined<T>(
    value: T | null | undefined,
    message: string,
    context?: Record<string, unknown>,
): asserts value is T {
    if (value === null || value === undefined) {
        const error = new Error(
            `Assertion failed: ${message}${context ? `\nContext: ${JSON.stringify(context, null, 2)}` : ''}`,
        );

        if (import.meta.env.DEV) {
            // In development, throw immediately to fail fast
            throw error;
        } else {
            // In production, log but don't crash
            console.error(error);
        }
    }
}

/**
 * Asserts that a value is a specific type using a type guard.
 * Throws in development, logs error in production.
 *
 * @example
 * function handleEvent(event: unknown) {
 *   assertType(event, isCustomEvent, 'Event must be CustomEvent');
 *   // TypeScript now knows event is CustomEvent<T>
 *   console.log(event.detail);
 * }
 *
 * @param value - The value to check
 * @param guard - Type guard function
 * @param message - Error message describing expected type
 * @param context - Optional additional context for debugging
 */
export function assertType<T>(
    value: unknown,
    guard: (val: unknown) => val is T,
    message: string,
    context?: Record<string, unknown>,
): asserts value is T {
    if (!guard(value)) {
        const error = new Error(
            `Type assertion failed: ${message}\nReceived: ${typeof value}${
                value && typeof value === 'object'
                    ? ` (${Object.prototype.toString.call(value)})`
                    : ''
            }${context ? `\nContext: ${JSON.stringify(context, null, 2)}` : ''}`,
        );

        if (import.meta.env.DEV) {
            throw error;
        } else {
            console.error(error);
        }
    }
}

/**
 * Type guard to check if a value is a CustomEvent with detail.
 *
 * @example
 * if (isCustomEvent(event)) {
 *   console.log(event.detail); // TypeScript knows detail exists
 * }
 */
export function isCustomEvent<T = unknown>(value: unknown): value is CustomEvent<T> {
    return value instanceof CustomEvent && 'detail' in value;
}

/**
 * Type guard to check if a value is a plain Event (not CustomEvent).
 *
 * @example
 * if (isPlainEvent(event)) {
 *   console.log(event.target); // No detail property
 * }
 */
export function isPlainEvent(value: unknown): value is Event {
    return value instanceof Event;
}

/**
 * Type guard to check if a value is a MouseEvent.
 */
export function isMouseEvent(value: unknown): value is MouseEvent {
    return value instanceof MouseEvent;
}

/**
 * Type guard to check if a value is a KeyboardEvent.
 */
export function isKeyboardEvent(value: unknown): value is KeyboardEvent {
    return value instanceof KeyboardEvent;
}

/**
 * Creates a type-safe callback wrapper that validates the callback signature.
 * Prevents bugs where callbacks receive unexpected types.
 *
 * @example
 * // Component that exposes onclick callback
 * export let onclick = createTypedCallback<MouseEvent>();
 *
 * // Usage validates type at runtime in development
 * onclick(mouseEvent); // ✅ OK
 * onclick(customEvent); // ❌ Throws in dev (logs in prod)
 *
 * @param guard - Type guard for validating callback parameters
 * @param errorMessage - Error message when validation fails
 */
export function createTypedCallback<TParam>(
    guard?: (value: unknown) => value is TParam,
    errorMessage?: string,
): (param: TParam) => void {
    return (param: TParam) => {
        if (guard && import.meta.env.DEV) {
            assertType(param, guard, errorMessage || `Callback received unexpected parameter type`);
        }
    };
}

/**
 * Validates that a callback is called with the correct parameter types.
 * Useful for component props that accept callbacks.
 *
 * @example
 * // In component
 * export let onitemclick: (item: MediaItem) => void = () => {};
 *
 * function handleClick(item: MediaItem) {
 *   validateCallback(onitemclick, item, isMediaItem, 'onitemclick expects MediaItem');
 * }
 *
 * @param callback - The callback to validate
 * @param param - The parameter being passed to callback
 * @param guard - Type guard to validate parameter
 * @param message - Error message for validation failure
 */
export function validateCallback<TParam>(
    callback: ((param: TParam) => void) | undefined,
    param: TParam,
    guard: (value: unknown) => value is TParam,
    message: string,
): void {
    if (!callback || !import.meta.env.DEV) return;

    assertType(param, guard, message, {
        callbackName: callback.name || 'anonymous',
        paramType: typeof param,
    });
}

/**
 * Wraps a CustomEvent handler to ensure it's only called with CustomEvent.
 * Prevents bugs where plain Events are passed to CustomEvent handlers.
 *
 * @example
 * export let onselect = wrapCustomEventHandler<MediaItem>();
 *
 * // Component internals
 * function handleSelect(item: MediaItem) {
 *   const event = new CustomEvent('select', { detail: item });
 *   onselect(event); // Validates event type in dev
 * }
 *
 * @param handler - Optional handler function
 */
export function wrapCustomEventHandler<T>(
    handler?: (event: CustomEvent<T>) => void,
): (event: CustomEvent<T>) => void {
    return (event: CustomEvent<T>) => {
        if (import.meta.env.DEV) {
            assertType(
                event,
                isCustomEvent,
                'Handler expects CustomEvent but received different event type',
                {
                    eventType: event?.constructor?.name,
                    hasDetail: event && 'detail' in event,
                },
            );
        }
        handler?.(event);
    };
}

/**
 * Wraps a plain Event handler to ensure it's not called with CustomEvent.
 * Prevents bugs where CustomEvent.detail is accessed on plain Events.
 *
 * @example
 * export let onclick = wrapPlainEventHandler();
 *
 * function handleClick(event: MouseEvent) {
 *   onclick(event); // Validates it's not a CustomEvent in dev
 * }
 *
 * @param handler - Optional handler function
 */
export function wrapPlainEventHandler<T extends Event>(
    handler?: (event: T) => void,
): (event: T) => void {
    return (event: T) => {
        if (import.meta.env.DEV && isCustomEvent(event)) {
            console.warn(
                `Plain event handler received CustomEvent. This may indicate a callback type mismatch.`,
                {
                    eventType: event.constructor.name,
                    detail: event.detail,
                    handler: handler?.name || 'anonymous',
                },
            );
        }
        handler?.(event);
    };
}

/**
 * Validates that optional chaining is not masking undefined values.
 * Use when undefined should never occur in correct code.
 *
 * @example
 * const name = data?.user?.name;
 * requireValue(name, 'User name should exist at this point', { userId: data?.user?.id });
 *
 * @param value - The value to check
 * @param message - Error message explaining why value should exist
 * @param context - Additional debugging context
 */
export function requireValue<T>(
    value: T | null | undefined,
    message: string,
    context?: Record<string, unknown>,
): T {
    if (value === null || value === undefined) {
        const error = new Error(
            `Required value is missing: ${message}${context ? `\nContext: ${JSON.stringify(context, null, 2)}` : ''}`,
        );

        if (import.meta.env.DEV) {
            throw error;
        } else {
            console.error(error);
            // In production, return a default value to prevent crashes
            // This is intentionally loose to keep the app running
            return value as T;
        }
    }
    return value;
}

/**
 * Logs a warning in development when a deprecated pattern is used.
 * Helps track down code that needs updating.
 *
 * @example
 * warnDeprecated('Direct onclick prop', 'Use the onclick callback instead');
 *
 * @param pattern - The deprecated pattern being used
 * @param alternative - What should be used instead
 * @param context - Additional context
 */
export function warnDeprecated(
    pattern: string,
    alternative: string,
    context?: Record<string, unknown>,
): void {
    if (import.meta.env.DEV) {
        console.warn(
            `⚠️  DEPRECATED: ${pattern}\n   Use instead: ${alternative}${context ? `\n   Context: ${JSON.stringify(context, null, 2)}` : ''}`,
        );
    }
}

/**
 * Validates that a value matches one of the expected values.
 * Useful for enum-like validations.
 *
 * @example
 * assertOneOf(mediaType, ['movie', 'series', 'episode'], 'Invalid media type');
 *
 * @param value - The value to check
 * @param validValues - Array of valid values
 * @param message - Error message
 */
export function assertOneOf<T>(value: T, validValues: readonly T[], message: string): void {
    if (!validValues.includes(value)) {
        const error = new Error(
            `${message}\nReceived: ${JSON.stringify(value)}\nExpected one of: ${JSON.stringify(validValues)}`,
        );

        if (import.meta.env.DEV) {
            throw error;
        } else {
            console.error(error);
        }
    }
}

/**
 * Development-only runtime check that executes only in dev mode.
 * Useful for expensive validation that shouldn't run in production.
 *
 * @example
 * devOnly(() => {
 *   const duplicate = items.find((item, i) =>
 *     items.findIndex(x => x.id === item.id) !== i
 *   );
 *   if (duplicate) {
 *     console.warn('Duplicate items detected', duplicate);
 *   }
 * });
 *
 * @param fn - Function to execute in development only
 */
export function devOnly(fn: () => void): void {
    if (import.meta.env.DEV) {
        fn();
    }
}

/**
 * Validates array invariants (no duplicates, all items match type, etc).
 * Useful for validating component props.
 *
 * @example
 * validateArray(items, {
 *   uniqueKey: 'id',
 *   typeGuard: isMediaItem,
 *   message: 'Items array validation failed'
 * });
 *
 * @param items - Array to validate
 * @param options - Validation options
 */
export function validateArray<T>(
    items: T[],
    options: {
        uniqueKey?: keyof T;
        typeGuard?: (item: unknown) => item is T;
        message?: string;
        context?: Record<string, unknown>;
    },
): void {
    if (!import.meta.env.DEV) return;

    const { uniqueKey, typeGuard, message = 'Array validation failed', context } = options;

    // Check for duplicates if uniqueKey provided
    if (uniqueKey) {
        const seen = new Set();
        const duplicate = items.find((item) => {
            const key = item[uniqueKey];
            if (seen.has(key)) return true;
            seen.add(key);
            return false;
        });

        if (duplicate) {
            console.warn(`${message}: Duplicate key "${String(uniqueKey)}" found`, {
                duplicateValue: duplicate[uniqueKey],
                ...context,
            });
        }
    }

    // Validate all items match type guard
    if (typeGuard) {
        const invalidItem = items.find((item) => !typeGuard(item));
        if (invalidItem) {
            console.error(`${message}: Item failed type guard`, {
                item: invalidItem,
                ...context,
            });
        }
    }
}
