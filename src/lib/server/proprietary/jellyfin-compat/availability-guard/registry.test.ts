// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import ts from 'typescript';
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

const root = resolve(__dirname, '../../../../../..');
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'fallback']);
const isEnterpriseRoute = (route: string): boolean => route.split('/').includes('(enterprise)');

function exportedMethods(source: string): string[] {
    const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    for (const statement of file.statements) {
        if (
            ts.isFunctionDeclaration(statement) &&
            statement.name &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        )
            names.push(statement.name.text);
        if (
            ts.isExportDeclaration(statement) &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause)
        ) {
            names.push(...statement.exportClause.elements.map((element) => element.name.text));
        }
        if (
            ts.isVariableStatement(statement) &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
                if (ts.isObjectBindingPattern(declaration.name))
                    names.push(
                        ...declaration.name.elements.map((element) => element.name.getText(file)),
                    );
            }
        }
    }
    return names.filter((name) => methods.has(name)).sort();
}

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
        const enterpriseInventory = {
            endpointDefs: endpointDefs.filter((def) => def.startsWith('enterprise/')),
            otherRoutes: otherRoutes.filter(isEnterpriseRoute),
            reviewedExternalArtwork: reviewedExternalArtwork.filter(([route]) =>
                isEnterpriseRoute(route),
            ),
        };
        // Preserve the complete reviewed private inventory. Only an entirely
        // stripped tree may omit it; deleting one private route/def still fails.
        if (existsSync(resolve(root, 'src/routes/(enterprise)'))) {
            expect(enterpriseInventory).toEqual({
                endpointDefs: [
                    'enterprise/admin/courses/[id].ts',
                    'enterprise/admin/courses/index.ts',
                    'enterprise/admin/courses/modules/[moduleId].ts',
                    'enterprise/admin/quizzes/[id].ts',
                    'enterprise/admin/quizzes/index.ts',
                    'enterprise/admin/quizzes/questions/[qid].ts',
                    'enterprise/admin/quizzes/questions/options/[oid].ts',
                    'enterprise/admin/quizzes/questions/options/index.ts',
                    'enterprise/admin/reporting/matrix/export.ts',
                    'enterprise/admin/reporting/users/[userId]/transcript/export.ts',
                    'enterprise/admin/showcase/library-group.ts',
                    'enterprise/admin/showcase/share-link.ts',
                    'enterprise/admin/trainings/[id].ts',
                    'enterprise/admin/trainings/index.ts',
                    'enterprise/courses/[id].ts',
                    'enterprise/courses/complete/[moduleId].ts',
                    'enterprise/courses/enroll/[id].ts',
                    'enterprise/my/trainings/acknowledge/[id].ts',
                    'enterprise/my/trainings/index.ts',
                    'enterprise/quizzes/attempts/[id].ts',
                    'enterprise/quizzes/submit/[attemptId].ts',
                    'enterprise/showcase/stream-token.ts',
                ],
                otherRoutes: [
                    '(enterprise)/showcase/hls/[id]/[...path]: GET,OPTIONS',
                    '(enterprise)/showcase/hls/[id]: GET,OPTIONS',
                    '(enterprise)/showcase/image/[id]/[type]: GET',
                    'api/(enterprise)/courses/[id]/enroll: POST',
                    'api/(enterprise)/courses/[id]/modules/[moduleId]/complete: POST',
                    'api/(enterprise)/courses/[id]: GET',
                    'api/(enterprise)/learn/modules/[moduleId]/complete: POST',
                    'api/(enterprise)/my/trainings/[id]/acknowledge: POST',
                    'api/(enterprise)/my/trainings: GET',
                    'api/(enterprise)/quizzes/[id]/attempts/[attemptId]/submit: POST',
                    'api/(enterprise)/quizzes/[id]/attempts: POST',
                    'api/(enterprise)/showcase/stream-token: POST',
                    'api/admin/(enterprise)/courses/[id]/modules/[moduleId]: DELETE,PATCH',
                    'api/admin/(enterprise)/courses/[id]: GET,PATCH,POST',
                    'api/admin/(enterprise)/courses: GET,POST',
                    'api/admin/(enterprise)/quizzes/[id]/questions/[qid]/options/[oid]: DELETE,PATCH',
                    'api/admin/(enterprise)/quizzes/[id]/questions/[qid]/options: POST',
                    'api/admin/(enterprise)/quizzes/[id]/questions/[qid]: DELETE,PATCH',
                    'api/admin/(enterprise)/quizzes/[id]: GET,PATCH,POST',
                    'api/admin/(enterprise)/quizzes: GET,POST',
                    'api/admin/(enterprise)/reporting/matrix/export: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT',
                    'api/admin/(enterprise)/reporting/users/[userId]/transcript/export: GET',
                    'api/admin/(enterprise)/showcase/library-group: DELETE,GET,POST',
                    'api/admin/(enterprise)/showcase/share-link: POST',
                    'api/admin/(enterprise)/trainings/[id]: DELETE,GET,PATCH',
                    'api/admin/(enterprise)/trainings: GET,POST',
                ],
                reviewedExternalArtwork: [
                    [
                        '(enterprise)/showcase/image/[id]/[type]',
                        'public showcase group only; UUIDs only',
                    ],
                ],
            });
        } else {
            expect(enterpriseInventory).toEqual({
                endpointDefs: [],
                otherRoutes: [],
                reviewedExternalArtwork: [],
            });
        }
        expect({
            reviewedExternalArtwork: reviewedExternalArtwork.filter(
                ([route]) => !isEnterpriseRoute(route),
            ),
            // A route added inside the fallback dispatcher creates no new
            // +server file. Require an inventory review for those edits too.
            jellyfinFallback: createHash('sha256')
                .update(routes.get('(proprietary)/j/[...path]')!)
                .digest('hex'),
            guarded: [...guarded]
                .sort()
                .map((route) => `${route}: ${exportedMethods(routes.get(route)!).join(',')}`),
            otherRoutes: otherRoutes.filter((route) => !isEnterpriseRoute(route)),
            endpointDefs: endpointDefs.filter((def) => !def.startsWith('enterprise/')),
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
