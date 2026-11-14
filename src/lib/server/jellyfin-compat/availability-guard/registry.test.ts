// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
import { exportedMethods } from './registry.test-helpers.js';
import { defRegistry, expandAliases, routeRegistry, reviewedExternalArtwork } from './registry.js';
import { surfaces, subsonicSurfaces } from './surfaces.js';

// Reviewed compat additions in otherRoutes: SyncPlay/List is an authenticated
// empty group-list stub; Users/{userId}/PlayedItems and Items/{itemId}/UserData
// return caller state only (UserItemDataDto), not catalog/browse media. Their
// canonical routes are already non-browse entries. FavoriteItems/PlayingItems
// aliases were already inventoried. CORS is a hook, with no new +server route.
// Upload target GET is session-owned admin operational data, not a browse surface.
// upload-attachment-targets.queries.integration.test.ts proves exact finalized-file/library
// binding, positive targets and negative missing/unbound-file cases.
// oauth/device/approve is authentication-only, like oauth/authorize: GET returns
// pending device recognition fields; POST returns a decision, never catalog media.

const root = resolve(__dirname, '../../../../..');
const isPrivateRoute = (route: string): boolean => route.split('/').includes('(private)');
const isPrivateDef = (def: string): boolean => def.startsWith('private/');

function subsonicRegistry(): string[] {
    const source = readFileSync(
        resolve(root, 'src/routes/subsonic/rest/[...path]/+server.ts'),
        'utf8',
    );
    const file = ts.createSourceFile('subsonic.ts', source, ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (
                declaration.name.getText(file) !== 'HANDLERS' ||
                !declaration.initializer ||
                !ts.isObjectLiteralExpression(declaration.initializer)
            )
                continue;
            return declaration.initializer.properties
                .map((property) => property.name!.getText(file))
                .sort();
        }
    }
    throw new Error('Subsonic dispatcher registry was not found');
}

describe('cross-surface availability inventory', () => {
    it('accounts for every route, endpoint def and Subsonic method (review new entries before updating)', () => {
        const routes = routeRegistry();
        const endpointDefs = defRegistry();
        const guarded = new Set(expandAliases(surfaces).map((spec) => spec.route));
        const subsonic = subsonicRegistry();
        const guardedSubsonic = new Set(subsonicSurfaces.map((spec) => spec.route));
        expect(routes.size).toBeGreaterThan(500);
        expect(endpointDefs.length).toBeGreaterThan(100);
        expect(subsonic.length).toBeGreaterThan(50);
        for (const method of guardedSubsonic) expect(subsonic).toContain(method);
        // The complement is deliberately snapshotted too. A new endpoint in
        // ANY namespace fails this test, including a new Siri/intent surface or
        // a handwritten route without an EndpointDef. Classify it and add a DB
        // case if it returns media. Never just regenerate this snapshot blindly.
        for (const [route] of reviewedExternalArtwork) expect(routes.has(route), route).toBe(true);
        const otherRoutes = [...routes]
            .filter(([route]) => !guarded.has(route))
            .map(([route, source]) => `${route}: ${exportedMethods(source).join(',')}`)
            .sort();
        const privateInventory = {
            endpointDefs: endpointDefs.filter(isPrivateDef),
            otherRoutes: otherRoutes.filter(isPrivateRoute),
            reviewedExternalArtwork: reviewedExternalArtwork.filter(([route]) =>
                isPrivateRoute(route),
            ),
        };
        // A tree without the private modules must carry none of their routes or defs. When the
        // private tree is present, its reviewed inventory is asserted by
        // registry.private-tree.test.ts (kept out of the public export).
        if (!existsSync(resolve(root, 'src/routes/(private)'))) {
            expect(privateInventory).toEqual({
                endpointDefs: [],
                otherRoutes: [],
                reviewedExternalArtwork: [],
            });
        }
        expect({
            reviewedExternalArtwork: reviewedExternalArtwork.filter(
                ([route]) => !isPrivateRoute(route),
            ),
            // A route added inside the fallback dispatcher creates no new
            // +server file. Require an inventory review for those edits too.
            jellyfinFallback: createHash('sha256')
                .update(routes.get('(modules)/j/[...path]')!)
                .digest('hex'),
            guarded: [...guarded]
                .sort()
                .map((route) => `${route}: ${exportedMethods(routes.get(route)!).join(',')}`),
            otherRoutes: otherRoutes.filter((route) => !isPrivateRoute(route)),
            endpointDefs: endpointDefs.filter((def) => !isPrivateDef(def)),
            guardedSubsonic: [...guardedSubsonic].sort(),
            otherSubsonic: subsonic.filter((method) => !guardedSubsonic.has(method)),
        }).toMatchSnapshot();
    });

    it('requires positive controls for every media-producing behavior', () => {
        for (const spec of [...surfaces, ...subsonicSurfaces]) {
            expect(
                spec.positive.length > 0 ||
                    Boolean(spec.positiveOneOf?.length) ||
                    (['search', 'getArtistInfo', 'getArtistInfo2'].includes(spec.route) &&
                        Boolean(spec.emptyReason)),
                spec.route,
            ).toBe(true);
        }
    });
});
