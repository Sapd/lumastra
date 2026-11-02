// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { login } from './harness';
/**
 * Test-harness login (the only non-spec call): mints a PAT per forward-auth test user and revokes
 * it afterwards. A real third-party client signs in through the OAuth device flow instead.
 * RECIPES_LIVETV_FORWARD_USER: a second user with Live TV access for recipe 08 (on preprod the
 * normal test user has none; Live TV access is a capability, not part of the plain user role).
 */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
    const closers: (() => Promise<void>)[] = [];
    if (!process.env.RECIPES_TOKEN) {
        if (!process.env.RECIPES_FORWARD_USER)
            throw new Error('Set RECIPES_TOKEN or RECIPES_FORWARD_USER');
        const auth = await login(
            process.env.RECIPES_FORWARD_USER,
            process.env.RECIPES_FORWARD_GROUPS ?? 'Users',
        );
        process.env.RECIPES_TOKEN = auth.token;
        closers.push(auth.close);
    }
    if (!process.env.RECIPES_LIVETV_TOKEN && process.env.RECIPES_LIVETV_FORWARD_USER) {
        const auth = await login(
            process.env.RECIPES_LIVETV_FORWARD_USER,
            process.env.RECIPES_LIVETV_FORWARD_GROUPS ?? 'Users',
        );
        process.env.RECIPES_LIVETV_TOKEN = auth.token;
        closers.push(auth.close);
    }
    return async () => {
        delete process.env.RECIPES_TOKEN;
        delete process.env.RECIPES_LIVETV_TOKEN;
        for (const close of closers) await close();
    };
}
