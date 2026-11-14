// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Surface } from './surfaces.js';

const root = resolve(__dirname, '../../../../..');
function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    );
}
export function routeRegistry(): Map<string, string> {
    const routesRoot = join(root, 'src/routes');
    return new Map(
        files(routesRoot)
            .filter((path) => path.endsWith('/+server.ts'))
            .map((path) => [
                relative(routesRoot, path).replace('/+server.ts', ''),
                readFileSync(path, 'utf8'),
            ]),
    );
}
export function defRegistry(): string[] {
    const defsRoot = join(root, 'src/lib/server/api/defs');
    return files(defsRoot)
        .filter(
            (path) =>
                !path.includes('.test.') &&
                readFileSync(path, 'utf8').includes('export const def = defineEndpoint('),
        )
        .map((path) => relative(defsRoot, path))
        .sort();
}
function defOf(source: string): string | undefined {
    return source.match(/from\s+['"]\$lib\/server\/api\/defs\/([^'"]+)['"]/)?.[1];
}
/** Invoke every mount of a guarded def, including legacy web URL aliases. */
export function expandAliases(specs: Surface[]): Surface[] {
    const registry = routeRegistry();
    return specs.flatMap((spec) => {
        const source = registry.get(spec.route);
        if (!source) throw new Error(`Guard route does not exist: ${spec.route}`);
        const def = defOf(source);
        const params = (route: string): string => (route.match(/\[[^\]]+\]/g) ?? []).join('/');
        const canonical = spec.route.replace('api/v1/', 'api/');
        const aliases = [...registry].filter(
            ([route, src]) =>
                route === spec.route ||
                (def &&
                    defOf(src) === def &&
                    /\bGET\b/.test(src) &&
                    params(route) === params(spec.route)) ||
                (canonical.startsWith('api/music') &&
                    route.replace('api/v1/', 'api/') === canonical),
        );
        return aliases.map(([route]) =>
            route === 'api/v1/seasons/[id]'
                ? { ...spec, route, query: { $id: 'season' }, positive: ['season'] }
                : { ...spec, route },
        );
    });
}

/** Reviewed non-browse artwork boundaries. Their access tests exercise real
 * library/age SQL; anonymous internal UUID images intentionally stay public.
 * Showcase publishes a configured group and does not resolve provider handles.
 */
export const reviewedExternalArtwork = [
    ['api/v1/media/[id]/images', 'catalog listing: external handles authenticate and gate'],
    ['api/v1/media/[id]/images/[role]', 'bytes: external handles authenticate and gate'],
    ['api/v1/media/[id]/images/[role]/[index]', 'delegates to the same byte gate'],
    ['api/media/[id]/images/[role]', 'internal mount of the same byte gate'],
    ['api/image/[id]/[type]', 'legacy: external handles authenticate and gate'],
    ['api/image/catalog/[id]/[type]', 'legacy catalog: external handles authenticate and gate'],
    // The public export removes this route group. Check the group rather than
    // the individual route so a missing route inside a private tree still fails.
    ...(existsSync(join(root, 'src/routes/(private)'))
        ? ([
              ['(private)/showcase/image/[id]/[type]', 'public showcase group only; UUIDs only'],
          ] as const)
        : []),
    [
        '(modules)/j/Items/[itemId]/Images/[imageType]',
        'public UUID artwork; provider handles do not resolve',
    ],
    [
        '(modules)/j/Items/[itemId]/Images/[imageType]/[imageIndex]',
        'same public UUID artwork handler',
    ],
] as const;
