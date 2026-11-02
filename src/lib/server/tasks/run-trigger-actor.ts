// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `trigger.by` for a manual run started over the API.
 *
 * A non-impersonating service token resolves to its CREATOR's `users.id` with
 * the username `service:<token name>`. Stamping the user id made every run an
 * automation started (an agent's preview, an *arr ingest push) count as the
 * creating admin's own manual run, so the admin's browser announced each one
 * ("… finished"). Service-token runs are attributed to the token's username
 * instead; an impersonating token's username is its target user, who did ask
 * for the run. Everything else keeps the `users.id` UUID.
 */
export function manualRunActor(
    principal: { kind: string; userId: string; username: string } | null | undefined,
): string {
    if (!principal) return 'unknown';
    return principal.kind === 'service_token' ? principal.username : principal.userId;
}

/** {@link manualRunActor} for callers holding the token-auth `ApiAuth` shape. */
export function manualRunActorFromApiAuth(auth: {
    tokenKind: 'pat' | 'svc';
    tokenId: string;
    userId: string;
    identity?: { username: string };
}): string {
    if (auth.tokenKind !== 'svc') return auth.userId;
    return auth.identity?.username ?? `service:${auth.tokenId}`;
}
