// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The metadata chain as the admin UI edits it.
 *
 * The chain is the ordered METADATA_PROVIDERS list: which `provider_metadata`
 * rows fill a field the merged ('aggregated') row lacks, top first. The admin
 * page used to show the plugin registry's provider ids
 * (`tmdb-metadata-provider`) and save them into `provider_capabilities` rows
 * keyed by short names, so every drag failed with "Provider … not found" and
 * the list on screen was never the one the server used.
 */

import { isEnvOverridden, saveConfig } from '$lib/server/config/index.js';
import {
    EDITABLE_CHAIN_SOURCES,
    getMetadataProviderChain,
} from '$lib/server/utils/provider-config.js';

export interface MetadataChainView {
    /** Current order, 'aggregated' (always first, implicit) excluded. */
    chain: string[];
    /** Sources that can still be added. */
    addable: string[];
    /** METADATA_PROVIDERS comes from the environment — the UI cannot change it. */
    envLocked: boolean;
}

export function getMetadataChainView(): MetadataChainView {
    const chain = getMetadataProviderChain().filter((p) => p !== 'aggregated');
    return {
        chain,
        addable: EDITABLE_CHAIN_SOURCES.filter((s) => !chain.includes(s)),
        envLocked: isEnvOverridden('METADATA_PROVIDERS'),
    };
}

export class MetadataChainError extends Error {
    constructor(
        message: string,
        readonly kind: 'invalid' | 'env-locked',
    ) {
        super(message);
    }
}

/**
 * Validate and persist a new order. Accepts the editable sources plus any name
 * already in the current chain (so a list that also carries e.g. `imdb` from
 * the environment or settings.json can still be reordered).
 */
export async function saveMetadataChain(requested: string[]): Promise<string[]> {
    if (isEnvOverridden('METADATA_PROVIDERS')) {
        throw new MetadataChainError(
            'METADATA_PROVIDERS is set by an environment variable; change it there',
            'env-locked',
        );
    }
    const current = getMetadataProviderChain();
    const allowed = new Set<string>([...EDITABLE_CHAIN_SOURCES, ...current]);
    allowed.delete('aggregated');

    const chain = requested.map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (chain.length === 0) {
        throw new MetadataChainError('The chain needs at least one source', 'invalid');
    }
    if (new Set(chain).size !== chain.length) {
        throw new MetadataChainError('A source appears twice', 'invalid');
    }
    const unknown = chain.filter((p) => !allowed.has(p));
    if (unknown.length > 0) {
        throw new MetadataChainError(`Unknown source: ${unknown.join(', ')}`, 'invalid');
    }

    await saveConfig({ METADATA_PROVIDERS: chain.join(',') });
    return chain;
}
