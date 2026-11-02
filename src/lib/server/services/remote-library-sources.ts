// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Remote library sources — enumerate the libraries a remote media server hosts,
 * so an operator can PICK one by name instead of typing a synthetic path.
 *
 * A {@link REMOTE_LIBRARY_PROVIDER_NAMES} row's `library_paths.path` is an opaque
 * `<scheme>://<upstream-id>` sentinel and its `provider_path` is the upstream id
 * itself. Neither is discoverable from Lumastra: the id lives in the remote
 * server's own admin UI. "Configurable" therefore has to mean "pick from the
 * live list", and that list has to come from somewhere the add-library form can
 * call without knowing which remote server it is talking to.
 *
 * ## Why an interface for one implementation
 *
 * Audiobookshelf is the only remote provider today, so this is not yet a
 * pattern. It is a seam, and it earns its keep twice over even at N=1:
 *
 *  - It keeps provider HTTP calls out of the Svelte component. The picker asks
 *    "list the libraries for provider X"; it never learns that ABS spells this
 *    `GET /api/libraries` or that its media-kind label is `book`.
 *  - It forces the not-configured / unreachable / empty distinction into the type
 *    ({@link RemoteLibraryListing}), which is the one thing a raw
 *    `getLibraries(): Promise<T[]>` cannot express.
 *
 * If a third remote source appears, the right move is to promote
 * `listLibraries` into the `defineMediaSource` contract — every source that can
 * enumerate its own libraries would then get the picker for free, and this
 * registry collapses into a registry lookup. That refactor is deliberately NOT
 * done here (one implementation does not justify widening a plugin contract that
 * external plugins also implement), but nothing below forecloses it: the shape
 * of {@link RemoteLibrarySource} is a subset of what a media source already
 * declares, so the promotion is a move, not a redesign.
 */

import * as m from '$lib/paraglide/messages';
import { describeSetupFetchFailure } from '$lib/server/utils/fetch-error-cause.js';
import { config } from '$lib/server/config.js';
import { AudiobookshelfClient } from '$lib/server/audiobookshelf.js';
// TYPE-only import of the query module. A VALUE import would make this file — and
// therefore every route that resolves a remote source — depend on that module at
// runtime, which breaks any test that partially mocks it: the mock has to
// re-export each symbol, so adding a new one here fails a dozen unrelated tests
// far from the change. `setup/library/server.test.ts` did exactly that when this
// read `REMOTE_LIBRARY_PROVIDERS` from there. The provider list is taken from
// `$lib/schemas/common` instead, which is where it is defined anyway.
import type { LibraryPathMediaType } from '$lib/server/database/queries/library-paths.queries.js';
import { REMOTE_LIBRARY_PROVIDER_NAMES } from '$lib/schemas/common.js';
import { getRemoteLibrarySourceDescriptor } from '$lib/shared/remote-library-sources.js';
import { requireValue } from '$lib/utils/runtime-validation.js';

/** A provider that hosts its libraries on a remote server. */
export type RemoteLibraryProvider = (typeof REMOTE_LIBRARY_PROVIDER_NAMES)[number];

/** One library offered in the picker. */
export interface RemoteLibraryOption {
    /** Upstream library id. Becomes `library_paths.provider_path`. */
    id: string;
    /**
     * Upstream's own name for the library, verbatim.
     *
     * Never parsed. One operator's libraries carry an ` - Englisch` suffix,
     * another's use `EN`/`DE`, Japanese, or no language split at all — so
     * language is asked for, never inferred from this string.
     */
    name: string;
    /** Upstream's media-kind label, shown only to disambiguate. */
    kind: string;
    /** False when Lumastra's ingest cannot handle this library kind. */
    supported: boolean;
    /** Why it is unsupported. Rendered next to the disabled option. */
    unsupportedReason?: string;
}

/**
 * The result of asking a remote source what it hosts.
 *
 * The three failure arms exist because they send the operator to three
 * different places, and a bare empty list sends them to the wrong one. See
 * `AudiobookshelfClient.listLibraries`.
 */
export type RemoteLibraryListing =
    | { status: 'ok'; libraries: RemoteLibraryOption[] }
    /** Credentials missing. `missingKeys` name the settings fields to fill in. */
    | { status: 'not_configured'; missingKeys: string[] }
    /** Configured, but the server did not answer usably. */
    | { status: 'unreachable'; message: string };

/**
 * Everything the add-library form needs to offer one remote provider, with no
 * provider-specific knowledge on the caller's side.
 */
export interface RemoteLibrarySource {
    provider: RemoteLibraryProvider;
    /** Operator-facing source name, e.g. "AudiobookShelf". */
    label: string;
    /** The `media_type` every library from this source ingests as. */
    mediaType: LibraryPathMediaType;
    /** Settings page where this source's credentials are configured. */
    settingsHref: string;
    /** Settings field keys this source needs before it can enumerate anything. */
    requiredKeys: string[];
    /**
     * Task id that ingests this source's libraries.
     *
     * Exists so callers do not fall back to `file-library-scan`, whose very first
     * action is to `readdir` `library_paths.path` — a URI, not a directory. That
     * run cannot do anything except fail, while burning a `bulk` slot and leaving
     * a misleading entry in the run history.
     */
    syncTaskId: string;
    /**
     * The `library_paths.path` sentinel for an upstream library id.
     *
     * Deliberately a function on the source rather than string concatenation at
     * the call site: the scheme is part of the provider's contract with
     * `normalizeLibraryPath`, and a hand-built sentinel elsewhere is how the two
     * drift.
     */
    pathFor(libraryId: string): string;
    listLibraries(): Promise<RemoteLibraryListing>;
}

/**
 * ABS library kinds Lumastra can ingest.
 *
 * ABS libraries are either `book` or `podcast`. The sweep builds `audiobook`
 * `media_items` from book metadata (`media.metadata.authors`, `narrators`,
 * `series`) — a podcast library would page fine and then produce rows with none
 * of that, so it is offered as disabled rather than silently accepted. Measured
 * on the live server: all four libraries report `book`.
 */
const ABS_SUPPORTED_KINDS: ReadonlySet<string> = new Set(['book']);

/**
 * Label, media type, settings href, required keys and URI scheme all come from
 * the client-safe descriptor, so the source selector and this implementation can
 * never disagree about what AudiobookShelf is called or where it is configured.
 */
const absDescriptor = requireValue(
    getRemoteLibrarySourceDescriptor('audiobookshelf'),
    'audiobookshelf descriptor must exist',
);

const audiobookshelfSource: RemoteLibrarySource = {
    provider: absDescriptor.provider,
    label: absDescriptor.label,
    mediaType: absDescriptor.mediaType,
    settingsHref: absDescriptor.settingsHref,
    requiredKeys: [...absDescriptor.requiredKeys],
    // String literal rather than an import of the task module: importing the task
    // would pull `registry.registerTask` into every route that resolves a remote
    // source, registering it as a side effect of an HTTP request.
    // `audiobookshelf-sync.integration.test.ts` asserts the registry holds this id.
    syncTaskId: 'audiobookshelf-sync',

    pathFor: (libraryId) => `${absDescriptor.scheme}://${libraryId}`,

    async listLibraries(): Promise<RemoteLibraryListing> {
        const missingKeys = [
            !config.AUDIOURL ? 'AUDIOURL' : null,
            !config.AUDIOAPIKEY ? 'AUDIOAPIKEY' : null,
        ].filter((k): k is string => k !== null);
        if (missingKeys.length > 0) {
            return { status: 'not_configured', missingKeys };
        }

        // A FRESH client per call, not the module singleton. The singleton
        // snapshots AUDIOURL/AUDIOAPIKEY at import time (so credentials an
        // operator just saved would never be observed) and latches
        // `connectionFailed` forever after one unreachable server — which would
        // turn every later "reachable?" answer into a stale `not-configured`.
        // Same reasoning as the media source's per-run client.
        const url = config.AUDIOURL;
        const apiKey = config.AUDIOAPIKEY;
        const client = new AudiobookshelfClient(url, apiKey);
        const result = await client.listLibraries();

        if (!result.ok) {
            return { status: 'unreachable', message: describeAbsError(result.error, url, apiKey) };
        }

        return { status: 'ok', libraries: toAbsLibraryOptions(result.value) };
    },
};

function toAbsLibraryOptions(
    libraries: ReadonlyArray<{ id: string; name: string; mediaType: string }>,
): RemoteLibraryOption[] {
    return libraries.map((lib) => ({
        id: lib.id,
        name: lib.name,
        kind: lib.mediaType,
        supported: ABS_SUPPORTED_KINDS.has(lib.mediaType),
        unsupportedReason: ABS_SUPPORTED_KINDS.has(lib.mediaType)
            ? undefined
            : `Lumastra can only ingest book libraries; this one is a ${lib.mediaType} library.`,
    }));
}

/**
 * Why a candidate AudiobookShelf connection did not work, as a fixed code.
 *
 * Codes rather than the client's message: a message can carry part of the
 * upstream body (a JSON parse error quotes it), and the URL being probed is
 * operator-typed, so echoing it would turn the probe into a way to read pages
 * from addresses only the server can reach.
 */
export type AudiobookshelfProbeFailure =
    | { reason: 'auth' }
    | { reason: 'network'; error: string }
    | { reason: 'http'; httpStatus: number }
    | { reason: 'not_audiobookshelf' };

/**
 * Probe a URL + API key the operator has NOT saved yet, and list its libraries.
 *
 * `GET /api/libraries` is both the credential check (ABS answers 401 for a bad
 * or disabled key) and the list the wizard offers next, so a connection that
 * passes here is one the sync can actually use. A fresh client, for the same
 * reasons as {@link audiobookshelfSource.listLibraries}.
 */
export async function probeAudiobookshelf(
    url: string,
    apiKey: string,
): Promise<
    { ok: true; libraries: RemoteLibraryOption[] } | ({ ok: false } & AudiobookshelfProbeFailure)
> {
    const result = await new AudiobookshelfClient(url, apiKey).listLibraries();
    if (result.ok) {
        // Only rows that look like ABS libraries: something else answering with
        // a `libraries` array must not produce checkboxes with no id behind
        // them. One odd row from a real server (a newer schema) is dropped
        // rather than failing the whole connection; a list where NO row looks
        // right is not an ABS server.
        const rows = result.value.filter(
            (lib) =>
                typeof lib?.id === 'string' &&
                lib.id !== '' &&
                typeof lib.name === 'string' &&
                typeof lib.mediaType === 'string',
        );
        if (rows.length === 0 && result.value.length > 0) {
            return { ok: false, reason: 'not_audiobookshelf' };
        }
        return { ok: true, libraries: toAbsLibraryOptions(rows) };
    }
    const { kind, status } = result.error;
    if (kind === 'http' && (status === 401 || status === 403)) return { ok: false, reason: 'auth' };
    if (kind === 'http' && status !== undefined) {
        return { ok: false, reason: 'http', httpStatus: status };
    }
    if (kind === 'malformed') return { ok: false, reason: 'not_audiobookshelf' };
    return {
        ok: false,
        reason: 'network',
        error: describeSetupFetchFailure(
            { code: result.error.code, name: result.error.name },
            url,
            [apiKey],
        ),
    };
}

/**
 * Turn a client error into something an operator can act on.
 *
 * Kept deliberately concrete about 401 — an API key that is present but wrong
 * (or an ABS key minted without `isActive`, which ABS accepts with a 200 and
 * then rejects on use) is otherwise indistinguishable from a bad URL.
 */
function describeAbsError(
    error: { kind: string; message: string; status?: number; code?: string; name?: string },
    url: string,
    apiKey: string,
): string {
    if (error.kind === 'http' && (error.status === 401 || error.status === 403)) {
        return m.setup_abs_error_auth();
    }
    if (error.kind === 'network') {
        return describeSetupFetchFailure({ code: error.code, name: error.name }, url, [apiKey]);
    }
    return error.message;
}

const SOURCES: Record<RemoteLibraryProvider, RemoteLibrarySource> = {
    audiobookshelf: audiobookshelfSource,
};

/** Every remote source, in a stable order for rendering the source selector. */
export const REMOTE_LIBRARY_SOURCES: readonly RemoteLibrarySource[] =
    REMOTE_LIBRARY_PROVIDER_NAMES.map((p) => SOURCES[p]);

export function getRemoteLibrarySource(provider: string): RemoteLibrarySource | undefined {
    return isRemoteLibraryProvider(provider) ? SOURCES[provider] : undefined;
}

/**
 * Narrow an arbitrary string to a remote provider.
 *
 * Exported because the setup and admin routes both need to decide "does this
 * provider's `path` touch a disk?" before validating it, and both must derive
 * that from {@link REMOTE_LIBRARY_PROVIDER_NAMES} rather than testing for
 * `'audiobookshelf'` — a second remote provider must not have to find and fix
 * every such literal.
 */
export function isRemoteLibraryProvider(
    provider: string | null | undefined,
): provider is RemoteLibraryProvider {
    return (
        provider !== null &&
        provider !== undefined &&
        (REMOTE_LIBRARY_PROVIDER_NAMES as readonly string[]).includes(provider)
    );
}

/** Type-level guard: every remote provider must have a source implementation. */
export type AssertEveryRemoteProviderHasSource =
    Exclude<RemoteLibraryProvider, keyof typeof SOURCES> extends never ? true : never;
