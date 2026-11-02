// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a plugin ACTUALLY registered, read back from the live registry.
 *
 * Lives in its own module because BOTH ends of the plugin lifecycle need it and
 * neither may import the other: `installer.ts` compares it against the signed
 * manifest on a fresh install, and `runtime/loader.ts` compares it against the
 * persisted manifest metadata on every load — which is the only place an
 * UPGRADE is ever checked, since the upgrade install path stages for restart
 * and never runs the fresh-install comparison.
 */
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { capabilitySubsetViolation } from './manifest.js';

export function readLoadedCapabilities(id: string, kind: string): Record<string, unknown> | null {
    let caps: unknown;
    switch (kind) {
        case 'task':
            caps = taskRegistry.getTask(id)?.capabilities;
            break;
        case 'provider':
            caps = taskRegistry.getProvider(id)?.capabilities;
            break;
        case 'trickplay':
            caps = taskRegistry.getTrickplay(id)?.capabilities;
            break;
        case 'watch-sync':
            caps = taskRegistry.getWatchSync(id)?.capabilities;
            break;
        case 'feature':
            caps = taskRegistry.getFeature(id)?.capabilities;
            break;
        case 'integration':
            caps = taskRegistry.getIntegration(id)?.capabilities;
            break;
        case 'external-service':
            caps = taskRegistry.getExternalService(id)?.capabilities;
            break;
        case 'media-source':
            caps = taskRegistry.getMediaSource(id)?.capabilities;
            break;
        case 'subtitle-provider':
            caps = taskRegistry.getSubtitleProvider(id)?.capabilities;
            break;
        case 'lyrics-provider':
            caps = taskRegistry.getLyricsProvider(id)?.capabilities;
            break;
        case 'auth-provider':
            caps = taskRegistry.getAuthProvider(id)?.capabilities;
            break;
        default:
            // A kind with no case here reads as `null`, and
            // capabilitySubsetViolation opens with `if (!declared || !loaded)
            // return null` — so a MISSING case does not fail open loudly, it
            // disables the signed capability bound for that whole contract
            // family in silence. These three were absent from the day they
            // shipped: a lyrics provider declaring nothing and registering
            // `database: true` installed clean. Adding a contract kind means
            // adding it HERE too; `readLoadedCapabilitiesCoversEveryKind` in
            // installer.test.ts fails if this switch falls behind PLUGIN_KIND.
            caps = undefined;
    }
    return caps && typeof caps === 'object' ? (caps as Record<string, unknown>) : null;
}

/**
 * Compare what a plugin's contracts actually registered against what its signed
 * manifest declared, for a whole (possibly multi-contract) bundle.
 *
 * Pure and injectable so the merge rules are testable without a database, a
 * filesystem or a live registry — the wiring in `loadOneDir` is then trivial.
 *
 * Contracts are merged before comparison because a bundle declares ONE
 * capability set covering everything it registers. For BOOLEAN capabilities
 * merging and per-contract comparison detect the same violations (a single
 * contract exceeding the set is caught either way); it matters for
 * `allowedDomains`, where each contract contributes hosts and only the
 * concatenation can be checked against what was declared.
 *
 * Returns null when nothing was declared. The `sawAny` guard is belt-and-braces
 * rather than load-bearing — an all-null read yields an empty merged set, which
 * violates nothing anyway — but it states the intent: an unreadable contract
 * kind is "unknown", not "registered nothing".
 */
export function bundleCapabilityViolation(
    declared: Record<string, unknown> | undefined,
    contracts: ReadonlyArray<{ id: string; kind: string }>,
    read: (id: string, kind: string) => Record<string, unknown> | null = readLoadedCapabilities,
): string | null {
    if (!declared) return null;
    const merged: Record<string, unknown> = {};
    let sawAny = false;
    for (const { id, kind } of contracts) {
        const caps = read(id, kind);
        if (!caps) continue;
        sawAny = true;
        for (const [k, v] of Object.entries(caps)) {
            if (v === true) merged[k] = true;
            else if (Array.isArray(v)) merged[k] = [...((merged[k] as unknown[]) ?? []), ...v];
            else if (merged[k] === undefined) merged[k] = v;
        }
    }
    if (!sawAny) return null;
    return capabilitySubsetViolation(declared, merged);
}

/**
 * The load-time capability verdict for one registry-managed plugin.
 *
 * Extracted from `loadOneDir` because the wiring there could not be tested:
 * forcing every load into a violation broke no test in the suite, so the
 * comparison could have been perfect while the gate never fired. That is the
 * same failure the gate itself guards against — something reporting "fine"
 * without having checked — and a gate whose refusal path has never executed is
 * indistinguishable from no gate.
 *
 * Takes the persisted metadata and the load result rather than reaching for
 * them, so the whole decision is reachable without a database, a filesystem or
 * a live registry. What remains in the loader is the refusal itself.
 */
export function loadTimeCapabilityViolation(
    manifestMetadata: unknown,
    loaded: { loaded: boolean; id?: string; kind?: string; ids?: string[]; kinds?: string[] },
    read?: (id: string, kind: string) => Record<string, unknown> | null,
): string | null {
    if (!loaded.loaded) return null;
    if (!manifestMetadata || typeof manifestMetadata !== 'object') return null;
    const declared = (manifestMetadata as { capabilities?: Record<string, unknown> }).capabilities;
    const ids = loaded.ids ?? (loaded.id ? [loaded.id] : []);
    const kinds = loaded.kinds ?? (loaded.kind ? [loaded.kind] : []);
    return bundleCapabilityViolation(
        declared,
        ids.map((id, i) => ({ id, kind: kinds[i] ?? '' })),
        read,
    );
}
