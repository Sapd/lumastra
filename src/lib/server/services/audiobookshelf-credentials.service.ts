// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-user AudiobookShelf credential resolution.
 *
 * Playback and outbound watch-sync use the listener's own ABS key (`GET
 * /api/me` and per-user writes). Keys are minted **lazily on first use** rather
 * than provisioned eagerly: most accounts never touch an audiobook, and
 * minting for all of them would create dozens of live credentials nobody asked
 * for. Scheduled inbound sync can separately read an unlinked listener through
 * the operator credential unless an explicit unlink tombstone exists.
 *
 * Minting itself requires admin-or-up on the operator-level `AUDIOAPIKEY`.
 *
 * Two behaviours here were measured against a real server, not assumed:
 *
 *  - **`isActive` must be passed explicitly.** ABS reads `!!req.body.isActive`,
 *    so omitting it returns HTTP 200 with a real-looking key whose `isActive` is
 *    `false` — and that key 401s on every request. Verified directly: omitted →
 *    `isActive: false` → `/api/me` 401; explicit `true` → `/api/me` 200, scoped
 *    to the intended user.
 *  - **ABS usernames are not lowercase.** An account may use mixed case or accents.
 *    Matching with `===` against a lowercased Lumastra username can silently fail
 *    to link the account — see {@link matchAbsUser}.
 */

import { Logger } from '../utils/logger.js';
import { foldUsername } from '$lib/shared/username-fold.js';

export { foldUsername } from '$lib/shared/username-fold.js';

const logger = Logger.for('AbsCredentials');

/** The fields of an ABS account this module needs. */
export interface AbsUserSummary {
    id: string;
    username: string;
}

/** What ABS returns when a key is minted. */
export interface AbsApiKey {
    id: string;
    apiKey: string;
    isActive: boolean;
}

/**
 * The ABS calls this module makes, injected so the resolution logic is testable
 * without a server and so callers can supply an operator-scoped client.
 */
export interface AbsCredentialDeps {
    /** `GET /api/users` — admin-scoped. */
    listUsers(): Promise<AbsUserSummary[]>;
    /** `POST /api/api-keys` — admin-scoped. */
    createApiKey(input: { name: string; userId: string; isActive: true }): Promise<AbsApiKey>;
    /** `PATCH /api/api-keys/:id { isActive: false }` — admin-scoped. */
    deactivateApiKey(apiKeyId: string): Promise<void>;
    /**
     * `GET /api/api-keys` — admin-scoped, METADATA only (no key material).
     *
     * Optional so the unlink path — which needs none of this — and existing
     * callers keep working. When absent, minting skips the stale-key sweep and
     * says so; the key still mints.
     */
    listApiKeys?(): Promise<AbsApiKeyInfo[]>;
    /**
     * `POST /api/users` — admin-scoped. Provision the ABS account a listener
     * does not have yet.
     *
     * Optional for the same reason as `listApiKeys`: the unlink and sync paths
     * do not need it. When absent, resolution behaves exactly as before and
     * reports the user as unlinked.
     */
    createUser?(input: { username: string; password: string }): Promise<AbsUserSummary>;
}

/** The subset of a listed ABS API key this module reasons about. */
export interface AbsApiKeyInfo {
    id: string;
    name?: string;
    userId?: string;
    isActive: boolean;
}

/**
 * Name every key this service mints, so the sweep below can recognise its own
 * keys and never touch one an operator created by hand.
 */
/**
 * A random password for an auto-provisioned ABS account.
 *
 * Never stored or shown: the account is driven by an API key, and ABS simply
 * refuses to create a user without a password. Uses the Web Crypto RNG so this
 * is not a predictable value on an account that does have a login form.
 */
function generateAbsPassword(): string {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function absApiKeyName(username: string): string {
    return `Lumastra (${username})`;
}

/** Keys this service is allowed to deactivate: ours, active, and this ABS user's. */
const LUMASTRA_KEY_PREFIX = 'Lumastra (';

/**
 * Deactivate this service's OWN previously-minted keys for one ABS user.
 *
 * A key's secret is returned only at creation (`GET /api/api-keys` carries no
 * `apiKey` field — verified live), so a replacement can never re-use an existing
 * key. Every re-mint therefore used to strand the previous key ACTIVE on the ABS
 * server. Observed on production: three live `Lumastra (…)` keys for one ABS
 * account, two of them orphaned — one live credential per master-key rotation or
 * per credential reset, accumulating forever.
 *
 * Scoped deliberately narrowly. A key is only swept when ALL hold:
 *  - its name starts with `Lumastra (` — never an operator's hand-made key, and
 *    in particular never the operator-level key this very call authenticates with;
 *  - its `userId` is the ABS account we are minting for — so one user's re-link
 *    cannot revoke another user's working key;
 *  - it is currently active — deactivating an inactive key is a wasted request.
 *
 * Case-insensitive on the name because Lumastra usernames differing only by case
 * (for example, `TestUser` vs `testuser`) can produce `Lumastra (TestUser)`
 * and `Lumastra (testuser)` for the same ABS user.
 *
 * Best-effort by design: hygiene must never block linking. Every failure is
 * logged and swallowed, and the caller mints regardless.
 */
async function deactivateStaleKeysForAbsUser(opts: {
    deps: AbsCredentialDeps;
    absUserId: string;
    username: string;
}): Promise<number> {
    const { deps, absUserId, username } = opts;
    if (!deps.listApiKeys) {
        logger.debug('AudiobookShelf: listApiKeys unavailable, skipping stale-key sweep', {
            username,
        });
        return 0;
    }

    let existing: AbsApiKeyInfo[];
    try {
        existing = await deps.listApiKeys();
    } catch (error) {
        logger.warn('AudiobookShelf: could not list API keys, minting without sweeping', {
            username,
            error: String(error),
        });
        return 0;
    }

    const stale = existing.filter(
        (key) =>
            key.isActive &&
            key.userId === absUserId &&
            (key.name ?? '').toLowerCase().startsWith(LUMASTRA_KEY_PREFIX.toLowerCase()),
    );

    let deactivated = 0;
    for (const key of stale) {
        try {
            await deps.deactivateApiKey(key.id);
            deactivated++;
        } catch (error) {
            // Left active upstream. Logged loudly because it is now an orphaned
            // live credential that an operator has to revoke by hand.
            logger.error(
                'AudiobookShelf: failed to deactivate a stale key; it stays LIVE and needs manual revocation',
                { username, apiKeyId: key.id, keyName: key.name, error: String(error) },
            );
        }
    }

    if (deactivated > 0) {
        logger.info('AudiobookShelf: deactivated stale per-user keys before minting', {
            username,
            absUserId,
            deactivated,
        });
    }
    return deactivated;
}

/** The slice of `PluginSecrets` this module uses. */
export interface UserSecretStore {
    getUserRaw(pluginId: string, userId: string, key: string): Promise<string | null>;
    setUser(pluginId: string, userId: string, key: string, value: string): Promise<void>;
    deleteUser(pluginId: string, userId: string, key: string): Promise<void>;
}

/** `plugin_user_credentials.plugin_id` for this connector. */
export const AUDIOBOOKSHELF_PLUGIN_ID = 'audiobookshelf';

/** Credential keys under that plugin id. */
export const API_KEY_SECRET = 'api_key';
/** The ABS-side key id, kept so unlink can deactivate it upstream. */
export const API_KEY_ID_SECRET = 'api_key_id';
/**
 * Durable tombstone written by an explicit unlink.
 *
 * The absence of a per-user key cannot itself mean "do not pull": listeners
 * who have only used ABS intentionally have no key. This separate marker lets
 * scheduled operator-scoped imports distinguish those users from somebody an
 * operator explicitly revoked. A later successful playback link clears it.
 */
export const PULL_DISABLED_SECRET = 'pull_disabled';

/**
 * Fold a username to a comparable form.
 *
 * NFC-normalises before lowercasing so a composed 'ö' (U+00F6) and a decomposed
 * 'o'+U+0308 compare equal — they render identically, so a mismatch here looks
 * like the code simply not working for usernames with accents.
 */
/**
 * Find the ABS account for a Lumastra username.
 *
 * Whole-string, case- and normalisation-insensitive. Returns `null` when there
 * is no match, and **also** when more than one ABS account folds to the same
 * name: ABS permits `TestUser` and `testuser` to coexist, and picking either one would
 * link a user to somebody else's listening history. Refusing to guess makes that
 * a visible "not linked" rather than silent cross-account data.
 */
export function matchAbsUser(
    absUsers: readonly AbsUserSummary[],
    lumastraUsername: string,
): AbsUserSummary | null {
    const target = foldUsername(lumastraUsername);
    if (!target) return null;

    const matches = absUsers.filter((u) => foldUsername(u.username) === target);
    if (matches.length === 1) return matches[0];

    if (matches.length > 1) {
        logger.warn('AudiobookShelf: refusing to link an ambiguous username', {
            username: lumastraUsername,
            candidates: matches.map((m) => m.username),
        });
    }
    return null;
}

export interface ResolveUserApiKeyOpts {
    secrets: UserSecretStore;
    deps: AbsCredentialDeps;
    /** Lumastra user UUID. */
    userId: string;
    /** Lumastra username; matched against ABS accounts. */
    username: string;
    /** Actual playback may re-enable inbound sync after an explicit unlink. */
    reenablePull?: boolean;
    /**
     * Provision an ABS account when the listener has none.
     *
     * Off unless the caller passes it, and the caller reads
     * `AUDIOBOOK_AUTO_CREATE_USERS` (default on) so an operator whose ABS server
     * is shared or whose identities come from elsewhere can refuse. Only
     * interactive playback should pass this: scheduled sync must not create
     * accounts for people who have never opened an audiobook.
     */
    autoCreate?: boolean;
}

/**
 * Return this user's ABS API key, minting one on first use.
 *
 * Returns `null` — never throws — when the user simply has no ABS counterpart,
 * because that is an ordinary steady state (local accounts, renamed users) and
 * must not fail the sync cycle for everybody else. Transport failures DO throw,
 * so the caller can classify them transient and retry next cycle.
 */
export async function resolveUserApiKey(opts: ResolveUserApiKeyOpts): Promise<string | null> {
    const { secrets, deps, userId, username, reenablePull = false, autoCreate = false } = opts;

    const existing = await secrets.getUserRaw(AUDIOBOOKSHELF_PLUGIN_ID, userId, API_KEY_SECRET);
    if (existing) {
        if (reenablePull) {
            await secrets.deleteUser(AUDIOBOOKSHELF_PLUGIN_ID, userId, PULL_DISABLED_SECRET);
        }
        return existing;
    }

    // Throws on an unreachable ABS / bad operator key rather than returning an
    // empty list — otherwise an outage is indistinguishable from "this user has
    // no ABS account" and every first-time link silently no-ops.
    const absUsers = await deps.listUsers();
    let absUser = matchAbsUser(absUsers, username);
    // matchAbsUser returns null for TWO different situations: nobody matches, and
    // several accounts fold to the same name. Only the first may be provisioned —
    // creating a third `testuser` next to `TestUser` and `testuser` would compound the
    // ambiguity matchAbsUser exists to refuse, and hand this listener a brand-new
    // empty library while their real history sits on one of the other two.
    const ambiguous =
        !absUser && absUsers.some((u) => foldUsername(u.username) === foldUsername(username));
    if (!absUser && !ambiguous && autoCreate && deps.createUser) {
        // Without this the listener is simply stuck: every audiobook returns
        // 403 "This account has no AudiobookShelf link", which reads as a
        // misconfiguration rather than a missing account. Creating it here
        // keeps the same lazy shape as the key mint below — nothing is
        // provisioned until somebody actually opens an audiobook.
        //
        // The password is random and discarded. These accounts are reached
        // through Lumastra, which has already authenticated the user; ABS only
        // ever sees the per-user API key minted against the account. ABS
        // rejects an empty password, so one has to exist.
        absUser = await deps.createUser({
            username,
            password: generateAbsPassword(),
        });
        logger.info('AudiobookShelf: provisioned an ABS account for a new listener', {
            username,
            absUserId: absUser.id,
        });
    }
    if (!absUser) {
        logger.debug('AudiobookShelf: no ABS account for Lumastra user, not linking', {
            username,
            autoCreate,
            ambiguous,
            canCreate: Boolean(deps.createUser),
        });
        return null;
    }

    // Sweep our own previously-minted keys for this ABS account BEFORE minting.
    // Deliberately before, not after: if the sweep ran afterwards it would have to
    // exclude the key just created, and any bug in that exclusion would revoke the
    // working key it had only just stored. Running first means the worst case is a
    // brief window with no valid key, which the mint immediately closes.
    await deactivateStaleKeysForAbsUser({ deps, absUserId: absUser.id, username });

    const minted = await deps.createApiKey({
        name: absApiKeyName(username),
        userId: absUser.id,
        // Explicit and non-optional in the type: ABS reads `!!req.body.isActive`,
        // so an omitted flag mints a key that 401s on every request.
        isActive: true,
    });

    // Defence in depth against the same footgun from the other side: never cache
    // a dead key. A stored inert key is worse than none — every later cycle
    // short-circuits on it above, 401s, and never re-mints.
    if (!minted.isActive || !minted.apiKey) {
        logger.error('AudiobookShelf: minted key came back inert, refusing to store it', {
            username,
            apiKeyId: minted.id,
            isActive: minted.isActive,
        });
        return null;
    }

    await secrets.setUser(AUDIOBOOKSHELF_PLUGIN_ID, userId, API_KEY_SECRET, minted.apiKey);
    await secrets.setUser(AUDIOBOOKSHELF_PLUGIN_ID, userId, API_KEY_ID_SECRET, minted.id);
    if (reenablePull) {
        await secrets.deleteUser(AUDIOBOOKSHELF_PLUGIN_ID, userId, PULL_DISABLED_SECRET);
    }

    logger.info('AudiobookShelf: minted per-user API key', {
        username,
        absUserId: absUser.id,
        apiKeyId: minted.id,
    });
    return minted.apiKey;
}

/**
 * Forget a user's cached key locally, WITHOUT calling ABS.
 *
 * For the case where ABS has already rejected the key (401/403): it is dead
 * upstream, so there is nothing to deactivate. Dropping the local row is what
 * lets the next cycle re-mint — without this, {@link resolveUserApiKey}
 * short-circuits on the cached dead key forever and the user never syncs again,
 * with no self-heal short of an operator running unlink by hand.
 */
export async function forgetUserApiKey(opts: {
    secrets: UserSecretStore;
    userId: string;
}): Promise<void> {
    await opts.secrets.deleteUser(AUDIOBOOKSHELF_PLUGIN_ID, opts.userId, API_KEY_SECRET);
    await opts.secrets.deleteUser(AUDIOBOOKSHELF_PLUGIN_ID, opts.userId, API_KEY_ID_SECRET);
}

export interface UnlinkUserApiKeyOpts {
    secrets: UserSecretStore;
    deps: AbsCredentialDeps;
    userId: string;
}

/**
 * Unlink a user: deactivate the key on ABS, then drop the local rows.
 *
 * `plugin_user_credentials` cascades on user delete, but the ABS-side key stays
 * live and usable — dropping only the local row leaks a working credential for
 * an account that believes it was unlinked.
 *
 * The local key rows are dropped even if the upstream deactivate fails, so an
 * unreachable ABS cannot leave the user permanently stuck in a linked state. The
 * upstream key is then orphaned-but-live; that is logged loudly for an operator
 * to revoke, and is the lesser of the two failures.
 */
export async function unlinkUserApiKey(opts: UnlinkUserApiKeyOpts): Promise<void> {
    const { secrets, deps, userId } = opts;

    // Persist the user's intent BEFORE touching the upstream key. If any later
    // cleanup fails, scheduled operator-scoped pulls must still stop.
    await secrets.setUser(AUDIOBOOKSHELF_PLUGIN_ID, userId, PULL_DISABLED_SECRET, 'true');

    const apiKeyId = await secrets.getUserRaw(AUDIOBOOKSHELF_PLUGIN_ID, userId, API_KEY_ID_SECRET);

    if (apiKeyId) {
        try {
            await deps.deactivateApiKey(apiKeyId);
        } catch (error) {
            logger.error(
                'AudiobookShelf: failed to deactivate key upstream; it stays LIVE and needs manual revocation',
                { userId, apiKeyId, error: String(error) },
            );
        }
    }

    await secrets.deleteUser(AUDIOBOOKSHELF_PLUGIN_ID, userId, API_KEY_SECRET);
    await secrets.deleteUser(AUDIOBOOKSHELF_PLUGIN_ID, userId, API_KEY_ID_SECRET);
}
