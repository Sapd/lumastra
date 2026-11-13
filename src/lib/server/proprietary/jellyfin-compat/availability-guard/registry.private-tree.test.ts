// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Private-tree companion of registry.test.ts: the complete reviewed inventory of the private
// modules' routes and endpoint defs. Listed in .publicignore, so it never ships.

import { describe, expect, it } from 'vitest';
import { defRegistry, expandAliases, routeRegistry, reviewedExternalArtwork } from './registry.js';
import { exportedMethods } from './registry.test-helpers.js';
import { surfaces } from './surfaces.js';

const isPrivateRoute = (route: string): boolean => route.split('/').includes('(private)');

describe('private modules availability inventory', () => {
    it('matches the reviewed inventory of private routes and endpoint defs', () => {
        const routes = routeRegistry();
        const endpointDefs = defRegistry();
        const guarded = new Set(expandAliases(surfaces).map((spec) => spec.route));
        const otherRoutes = [...routes]
            .filter(([route]) => !guarded.has(route))
            .map(([route, source]) => `${route}: ${exportedMethods(source).join(',')}`)
            .sort();
        const privateInventory = {
            endpointDefs: endpointDefs.filter((def) => def.startsWith('private/')),
            otherRoutes: otherRoutes.filter(isPrivateRoute),
            reviewedExternalArtwork: reviewedExternalArtwork.filter(([route]) =>
                isPrivateRoute(route),
            ),
        };
        expect(privateInventory).toEqual({
            endpointDefs: [
                'private/admin/courses/[id].ts',
                'private/admin/courses/index.ts',
                'private/admin/courses/modules/[moduleId].ts',
                'private/admin/quizzes/[id].ts',
                'private/admin/quizzes/index.ts',
                'private/admin/quizzes/questions/[qid].ts',
                'private/admin/quizzes/questions/options/[oid].ts',
                'private/admin/quizzes/questions/options/index.ts',
                'private/admin/reporting/matrix/export.ts',
                'private/admin/reporting/users/[userId]/transcript/export.ts',
                'private/admin/showcase/library-group.ts',
                'private/admin/showcase/share-link.ts',
                'private/admin/trainings/[id].ts',
                'private/admin/trainings/index.ts',
                'private/courses/[id].ts',
                'private/courses/complete/[moduleId].ts',
                'private/courses/enroll/[id].ts',
                'private/my/trainings/acknowledge/[id].ts',
                'private/my/trainings/index.ts',
                'private/quizzes/attempts/[id].ts',
                'private/quizzes/submit/[attemptId].ts',
                'private/showcase/stream-token.ts',
            ],
            otherRoutes: [
                '(private)/showcase/hls/[id]/[...path]: GET,OPTIONS',
                '(private)/showcase/hls/[id]: GET,OPTIONS',
                '(private)/showcase/image/[id]/[type]: GET',
                'api/(private)/courses/[id]/enroll: POST',
                'api/(private)/courses/[id]/modules/[moduleId]/complete: POST',
                'api/(private)/courses/[id]: GET',
                'api/(private)/learn/modules/[moduleId]/complete: POST',
                'api/(private)/my/trainings/[id]/acknowledge: POST',
                'api/(private)/my/trainings: GET',
                'api/(private)/quizzes/[id]/attempts/[attemptId]/submit: POST',
                'api/(private)/quizzes/[id]/attempts: POST',
                'api/(private)/showcase/stream-token: POST',
                'api/admin/(private)/courses/[id]/modules/[moduleId]: DELETE,PATCH',
                'api/admin/(private)/courses/[id]: GET,PATCH,POST',
                'api/admin/(private)/courses: GET,POST',
                'api/admin/(private)/quizzes/[id]/questions/[qid]/options/[oid]: DELETE,PATCH',
                'api/admin/(private)/quizzes/[id]/questions/[qid]/options: POST',
                'api/admin/(private)/quizzes/[id]/questions/[qid]: DELETE,PATCH',
                'api/admin/(private)/quizzes/[id]: GET,PATCH,POST',
                'api/admin/(private)/quizzes: GET,POST',
                'api/admin/(private)/reporting/matrix/export: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT',
                'api/admin/(private)/reporting/users/[userId]/transcript/export: GET',
                'api/admin/(private)/showcase/library-group: DELETE,GET,POST',
                'api/admin/(private)/showcase/share-link: POST',
                'api/admin/(private)/trainings/[id]: DELETE,GET,PATCH',
                'api/admin/(private)/trainings: GET,POST',
            ],
            reviewedExternalArtwork: [
                [
                    '(private)/showcase/image/[id]/[type]',
                    'public showcase group only; UUIDs only',
                ],
            ],
        });
    });
});
