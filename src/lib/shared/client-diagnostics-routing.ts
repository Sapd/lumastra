// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared wire guards; keep raw resource ids out of diagnostic keys. */
export const UUID_LOOKING = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
export const ROUTE_KEY =
    /^(?!.*[?#])(?!.*:\/\/)(?!.*[0-9a-f]{8}-[0-9a-f]{4}-)[A-Za-z0-9_\-./:{}]{1,160}$/i;

export function hasPureDigitSegment(route: string): boolean {
    return route.split('/').some((segment) => /^\d+$/.test(segment));
}

/** Preserve the server pathname (including base), dropping queries and templating ids. */
export function diagnosticRouteTemplate(endpoint: string): string {
    const pathname = new URL(endpoint, 'https://diagnostic.invalid').pathname;
    const route = pathname
        .split('/')
        .map((segment) =>
            UUID_LOOKING.test(segment) ||
            /^\d+$/.test(segment) ||
            !/^[A-Za-z0-9_\-.:{}]*$/.test(segment)
                ? ':id'
                : segment,
        )
        .join('/')
        .slice(0, 157);
    return route
        .split('/')
        .map((segment) => (/^\d+$/.test(segment) ? ':id' : segment))
        .join('/');
}

export function diagnosticKeyPath(path: readonly PropertyKey[]): string {
    return path
        .map((part) => (UUID_LOOKING.test(String(part)) ? ':id' : String(part)))
        .join('.')
        .slice(0, 200);
}
