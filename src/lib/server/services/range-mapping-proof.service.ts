// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import { parseMediaFilename } from '$lib/server/utils/filename-parser.js';
import { isAbsolute, relative, resolve } from 'node:path';
import { assessFilePresence } from '$lib/server/utils/file-presence.js';
import { safeRealpath, safeStatBigInt } from '$lib/server/utils/safe-fs.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getRangeMappingGraph,
    type RangeMappingGraph,
} from '$lib/server/database/queries/range-mapping-proof.queries.js';
import {
    RangeMappingProofSchema,
    type RangeMappingParticipant,
} from '$lib/schemas/range-mapping-proof.js';

class RangeMappingChangedError extends Error {}

function inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
/** Positive presence + resolved containment + precise regular-file witness, never an absence heuristic. */
export async function observeRangeParticipant(
    file: RangeMappingGraph['files'][number],
    root: string,
    signal?: AbortSignal,
): Promise<RangeMappingParticipant | null> {
    if (
        root.length > 4096 ||
        file.path.length > 4096 ||
        !isAbsolute(root) ||
        !isAbsolute(file.path) ||
        !inside(resolve(root), resolve(file.path))
    )
        return null;
    if ((await assessFilePresence(file.path, { mountRoot: root, signal })) !== 'present')
        return null;
    try {
        signal?.throwIfAborted();
        const realRoot = await safeRealpath(root, 2000);
        const realPath = await safeRealpath(file.path, 2000);
        if (
            !inside(realRoot, realPath) ||
            realPath !== resolve(realRoot, relative(resolve(root), resolve(file.path)))
        )
            return null;
        const stat = await safeStatBigInt(realPath, 2000, signal);
        // Node's Date and nanosecond stat conversion may round the stored
        // millisecond in opposite directions. Keep the exact ns witness, while
        // allowing only that sub-millisecond representation difference.
        const delta = stat.mtimeNs - BigInt(file.mtimeMs) * 1000000n;
        if (
            !stat.isFile() ||
            stat.size <= 0n ||
            stat.mtimeNs < 0n ||
            stat.ctimeNs < 0n ||
            String(stat.size) !== file.size ||
            delta <= -1000000n ||
            delta >= 1000000n
        )
            return null;
        // Re-resolve after stat so a moving symlink cannot bind an escaped stat to a safe name.
        if (
            (await safeRealpath(file.path, 2000)) !== realPath ||
            (await safeRealpath(root, 2000)) !== realRoot
        )
            return null;
        return {
            fileId: file.id,
            path: file.path,
            generation: file.generation,
            root,
            realRoot,
            realPath,
            regularFile: true,
            dev: String(stat.dev),
            ino: String(stat.ino),
            size: String(stat.size),
            mtimeMs: file.mtimeMs,
            mtimeNs: String(stat.mtimeNs),
            ctimeNs: String(stat.ctimeNs),
        };
    } catch {
        return null;
    }
}

export interface RecordRangeProofArgs {
    fileId: string;
    seasonId: string;
    first: number;
    last: number;
    dedicatedIds: string[];
    signal?: AbortSignal;
}
/**
 * Caller has recorded a raw stub. Observe outside locks, then revalidate inside
 * a savepoint. NOWAIT avoids reversing any episode/item locks held by an owner
 * callback. Busy/drifting participants leave a raw actionable warning.
 */
export async function recordCurrentRangeMappingProof(
    sql: postgres.Sql,
    args: RecordRangeProofArgs,
): Promise<boolean> {
    const signal = args.signal
        ? AbortSignal.any([args.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000);
    const before = await getRangeMappingGraph(sql, args);
    if (!before || signal.aborted) return false;
    const range = parseMediaFilename(before.files[0].path);
    if (
        (range.episodeStart ?? range.episode) !== args.first ||
        range.episodeEnd !== args.last ||
        range.season !== before.seasonNumber
    )
        return false;
    for (let i = 1; i < before.files.length; i++) {
        const dedicated = parseMediaFilename(before.files[i].path);
        if (
            dedicated.episodeEnd !== undefined ||
            (dedicated.episodeStart ?? dedicated.episode) !== args.first + i - 1 ||
            dedicated.season !== before.seasonNumber
        )
            return false;
    }
    const participants: RangeMappingParticipant[] = [];
    for (const file of before.files) {
        const witness = await observeRangeParticipant(file, before.root.path, signal);
        if (!witness) return false;
        participants.push(witness);
    }
    try {
        return await withTx(sql, async (tx) => {
            await tx`SELECT id FROM media_files WHERE id = ANY(${before.files.map((f) => f.id)}::uuid[]) ORDER BY id FOR UPDATE NOWAIT`;
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Privileged scanner proof commit; the admin projection is separately gated.
            await tx`SELECT id FROM media_items WHERE id = ANY(${[before.seasonId, before.seriesId, ...before.claims.map((c) => c.episodeId)]}::uuid[]) ORDER BY id FOR UPDATE NOWAIT`;
            await tx`SELECT file_id FROM media_file_items WHERE file_id = ANY(${args.dedicatedIds}::uuid[]) ORDER BY file_id FOR SHARE NOWAIT`;
            await tx`SELECT id FROM library_paths WHERE id = ${before.root.id}::uuid FOR UPDATE NOWAIT`;
            await tx`SELECT media_id FROM external_ids WHERE media_id = ANY(${[before.seasonId, before.seriesId, ...before.claims.map((c) => c.episodeId)]}::uuid[]) FOR SHARE NOWAIT`;
            const current = await getRangeMappingGraph(tx, args);
            if (JSON.stringify(current) !== JSON.stringify(before)) return false;
            for (let i = 0; i < before.files.length; i++) {
                const after = await observeRangeParticipant(
                    before.files[i],
                    before.root.path,
                    signal,
                );
                if (JSON.stringify(after) !== JSON.stringify(participants[i])) return false;
            }
            signal.throwIfAborted();
            const proof = RangeMappingProofSchema.parse({
                version: 1,
                observedAt: new Date().toISOString(),
                participants,
            });
            await tx`INSERT INTO file_range_mapping_proofs (file_id, season_id, first_episode, last_episode, dedicated_ids, graph, proof)
                VALUES (${args.fileId}::uuid, ${args.seasonId}::uuid, ${args.first}, ${args.last}, ${args.dedicatedIds}::uuid[],
                    ${tx.json(before as unknown as postgres.JSONValue)}, ${tx.json(proof)})
                ON CONFLICT (file_id) DO UPDATE SET season_id = EXCLUDED.season_id, first_episode = EXCLUDED.first_episode,
                    last_episode = EXCLUDED.last_episode, dedicated_ids = EXCLUDED.dedicated_ids, graph = EXCLUDED.graph, proof = EXCLUDED.proof`;
            const [valid] = await tx<
                { current: boolean }[]
            >`SELECT current_range_mapping_proof(${args.fileId}::uuid) AS current`;
            if (!valid.current)
                throw new RangeMappingChangedError('Range mapping changed while recording');
            return true;
        });
    } catch (error) {
        // Contention/cancellation is inconclusive, never a reason to clear issues.
        if (
            error instanceof RangeMappingChangedError ||
            signal.aborted ||
            (typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === '55P03')
        )
            return false;
        throw error;
    }
}
