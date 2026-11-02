// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data Extraction Utilities
 *
 * Centralized type guards and data extraction helpers for safely
 * handling unknown values from API responses, database queries, etc.
 *
 * These functions are designed to work in both client and server contexts.
 */

/**
 * Type guard for checking if a value is a plain object (Record).
 *
 * @example
 * if (isRecord(value)) {
 *   const name = value.name; // TypeScript knows this is safe
 * }
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

/**
 * Extract a string from an unknown value.
 * Returns undefined if the value is not a string.
 *
 * @example
 * const name = toString(data.name); // string | undefined
 */
export const toString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

/**
 * Extract a string with a fallback default value.
 *
 * @example
 * const status = toStringOr(data.status, 'unknown'); // string
 */
export const toStringOr = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;

/**
 * Format a username for display.
 * Capitalizes the first letter so stored lowercase names (e.g. "testuser") read
 * naturally as "Testuser". Extend this function if username formats change
 * (e.g. "first.last" → "First Last", email addresses, etc.).
 *
 * @example
 * formatUsername('testuser')  // 'Testuser'
 * formatUsername('ADMIN')  // 'Admin'
 */
export const formatUsername = (username: string): string =>
    username.length === 0 ? username : username[0].toUpperCase() + username.slice(1).toLowerCase();

/**
 * Extract a number from an unknown value.
 * Returns undefined if the value is not a finite number.
 *
 * @example
 * const count = toNumber(data.count); // number | undefined
 */
export const toNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Extract a number with a fallback default value.
 *
 * @example
 * const limit = toNumberOr(data.limit, 10); // number
 */
export const toNumberOr = (value: unknown, fallback: number): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return fallback;
};

/**
 * Parse a number from unknown value, including string parsing.
 * Useful for query parameters and form data.
 *
 * @example
 * const page = parseNumber(searchParams.get('page')); // number | undefined
 */
export const parseNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
};

/**
 * Parse a number from unknown value with fallback.
 *
 * @example
 * const page = parseNumberOr(searchParams.get('page'), 1); // number
 */
export const parseNumberOr = (value: unknown, fallback: number): number =>
    parseNumber(value) ?? fallback;

/**
 * Parse an integer from unknown value, including string parsing.
 *
 * @example
 * const id = parseInteger(params.id); // number | undefined
 */
export const parseInteger = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
};

/**
 * Parse an integer from unknown value with fallback.
 *
 * @example
 * const page = parseIntegerOr(params.page, 1); // number
 */
export const parseIntegerOr = (value: unknown, fallback: number): number =>
    parseInteger(value) ?? fallback;

/**
 * Extract a boolean from an unknown value.
 * Returns undefined if the value is not a boolean.
 *
 * @example
 * const enabled = toBoolean(data.enabled); // boolean | undefined
 */
export const toBoolean = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined;

/**
 * Extract a boolean with a fallback default value.
 *
 * @example
 * const enabled = toBooleanOr(data.enabled, false); // boolean
 */
export const toBooleanOr = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

/**
 * Parse a boolean from unknown value, including string parsing.
 * Recognizes: true, false, "true", "false", "1", "0", 1, 0
 *
 * @example
 * const showAll = parseBoolean(searchParams.get('showAll')); // boolean | undefined
 */
export const parseBoolean = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
    }
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    return undefined;
};

/**
 * Parse a boolean from unknown value with fallback.
 *
 * @example
 * const showAll = parseBooleanOr(searchParams.get('showAll'), false); // boolean
 */
export const parseBooleanOr = (value: unknown, fallback: boolean): boolean =>
    parseBoolean(value) ?? fallback;

/**
 * Extract an array of strings from an unknown value.
 * Filters out non-string elements.
 *
 * @example
 * const tags = toStringArray(data.tags); // string[]
 */
export const toStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Extract an array of numbers from an unknown value.
 * Filters out non-number elements.
 *
 * @example
 * const ids = toNumberArray(data.ids); // number[]
 */
export const toNumberArray = (value: unknown): number[] =>
    Array.isArray(value)
        ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
        : [];

/**
 * Type guard for arrays of a specific type.
 *
 * @example
 * if (isArrayOf(value, isRecord)) {
 *   // value is Record<string, unknown>[]
 * }
 */
export const isArrayOf = <T>(value: unknown, guard: (item: unknown) => item is T): value is T[] =>
    Array.isArray(value) && value.every(guard);

/**
 * Check if a value is null or undefined.
 *
 * @example
 * if (isNullish(value)) return defaultValue;
 */
export const isNullish = (value: unknown): value is null | undefined =>
    value === null || value === undefined;

/**
 * Check if a value is not null or undefined.
 * Useful for filtering arrays.
 *
 * @example
 * const validItems = items.filter(isNotNullish);
 */
export const isNotNullish = <T>(value: T | null | undefined): value is T =>
    value !== null && value !== undefined;

/**
 * Safely get a nested property from an unknown object.
 *
 * @example
 * const name = getProperty(data, 'user', 'profile', 'name'); // unknown
 */
export const getProperty = (value: unknown, ...path: string[]): unknown => {
    let current = value;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
};

/**
 * Safely get a string property from an unknown object.
 *
 * @example
 * const name = getStringProperty(data, 'user', 'name'); // string | undefined
 */
export const getStringProperty = (value: unknown, ...path: string[]): string | undefined =>
    toString(getProperty(value, ...path));

/**
 * Safely get a number property from an unknown object.
 *
 * @example
 * const age = getNumberProperty(data, 'user', 'age'); // number | undefined
 */
export const getNumberProperty = (value: unknown, ...path: string[]): number | undefined =>
    toNumber(getProperty(value, ...path));

/**
 * Extract body data from a request, returning a validated record.
 *
 * @example
 * const data = await extractBody(request);
 * const name = toString(data.name);
 */
export const extractBody = async (request: Request): Promise<Record<string, unknown>> => {
    try {
        const body: unknown = await request.json();
        return isRecord(body) ? body : {};
    } catch {
        /* expected: request body may be absent or non-JSON */
        return {};
    }
};

/**
 * Capitalize the first letter of a username for display.
 * Leaves the rest of the string unchanged.
 *
 * @example
 * displayName('testuser') // 'Testuser'
 * displayName('tina')  // 'Tina'
 */
export function displayName(username: string): string {
    if (!username) return username;
    return username.charAt(0).toUpperCase() + username.slice(1);
}
