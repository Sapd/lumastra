// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 11/13. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, expectOk } from './client';
test('02 show the home screen', async () => {
    const feed = expectOk('GET', '/feed', await client.GET('/api/v1/feed'));
    expect(feed).toHaveProperty('sections');
    const resume = expectOk(
        'GET',
        '/continue-watching',
        await client.GET('/api/v1/continue-watching'),
    );
    expect(resume).toHaveProperty('items');
});
