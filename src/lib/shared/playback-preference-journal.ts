// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { safeRandomUUID } from '$lib/utils/safe-uuid';

/** Durable coordination metadata survives logout; account values do not. */
export const PREFERENCE_EPOCH_KEY = 'lumastra:pref-account-epoch';
export const PREFERENCE_PERMIT_KEY = 'lumastra:pref-account-permit';
export const PREFERENCE_BROWSER_ID_KEY = 'lumastra:pref-browser-id';
export const PREFERENCE_JOURNAL_PREFIX = 'lumastra:pref-journal:';
export const PREFERENCE_ACK_PREFIX = 'lumastra:pref-ack:';
export const LEGACY_PREFERENCE_DIRTY_KEY = 'lumastra:pref-dirty';
const CACHE_EPOCH_FIELD = '__lumastraPreferenceEpoch';

export interface PreferenceStorage {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
interface PreferenceEpoch {
    id: string;
    cleared: boolean;
    generation: string;
    permit: boolean;
    retired?: boolean;
}
const GENERATION_WIDTH = 16;
function generationAfter(previous = 0): string {
    return Math.max(Date.now(), previous + 1)
        .toString()
        .padStart(GENERATION_WIDTH, '0');
}
export interface PreferenceJournalEdit {
    storageKey: string;
    serialized: string;
    epoch: string;
    owner: string;
    id: string;
    field: string;
    value: unknown;
    revision: number;
    updatedAt: number;
}
export interface PreferenceFieldAcknowledgement {
    epoch: string;
    field: string;
    value: unknown;
    updatedAt: number;
    id: string;
}
function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function parse(raw: string | null): unknown {
    try {
        return raw === null ? undefined : JSON.parse(raw);
    } catch {
        return undefined;
    }
}
function identifier(): string {
    return safeRandomUUID();
}

function epochFrom(raw: string | null): PreferenceEpoch | undefined {
    if (raw && /^!\d{16}$/.test(raw) && Number.isSafeInteger(Number(raw.slice(1))))
        return {
            id: `retired-${raw.slice(1)}`,
            cleared: true,
            generation: raw.slice(1),
            permit: true,
            retired: true,
        };
    const value = parse(raw);
    return object(value) &&
        typeof value.id === 'string' &&
        value.id.length > 0 &&
        typeof value.cleared === 'boolean'
        ? {
              id: value.id,
              cleared: value.cleared,
              permit: value.permit === true,
              generation:
                  typeof value.generation === 'string' &&
                  /^\d{16}$/.test(value.generation) &&
                  Number.isSafeInteger(Number(value.generation)) &&
                  Number(value.generation) > 0
                      ? value.generation
                      : '0000000000000001',
          }
        : undefined;
}

/** Always changes the signal, including when the preference cache is absent. */
export function advancePreferenceEpoch(storage: PreferenceStorage): void {
    const previous = epochFrom(storage.getItem(PREFERENCE_EPOCH_KEY));
    const next = JSON.stringify({
        id: identifier(),
        cleared: true,
        generation: generationAfter(previous ? Number(previous.generation) : 0),
        permit: true,
    });
    storage.setItem(PREFERENCE_EPOCH_KEY, next);
    if (storage.getItem(PREFERENCE_EPOCH_KEY) !== next)
        throw new Error('Preference cleanup epoch was not stored');
}

/** A compact retirement fence fits even a legacy marker with no generation field. */
export function retirePreferenceEpoch(storage: PreferenceStorage): void {
    const previous = epochFrom(storage.getItem(PREFERENCE_EPOCH_KEY));
    const next = `!${generationAfter(previous ? Number(previous.generation) : 0)}`;
    storage.setItem(PREFERENCE_EPOCH_KEY, next);
    if (storage.getItem(PREFERENCE_EPOCH_KEY) !== next)
        throw new Error('Preference retirement fence was not stored');
}

/** Immutable per-edit keys avoid deleting a sibling's newer write during acknowledgement. */
export class PlaybackPreferenceJournal {
    private account: PreferenceEpoch;
    private browserId?: string;
    readonly owner: string;
    constructor(
        private readonly storage: PreferenceStorage,
        private readonly allowedField: (field: string) => boolean,
        private readonly newId: () => string = identifier,
        private readonly now: () => number = Date.now,
    ) {
        this.owner = newId();
        this.account = this.ensureEpoch();
    }
    get epoch(): string {
        return this.account.id;
    }
    get cleared(): boolean {
        return this.account.cleared;
    }
    get generation(): number {
        return Number(this.account.generation);
    }
    private get(key: string): string | null {
        try {
            return this.storage.getItem(key);
        } catch {
            return null;
        }
    }
    private put(key: string, value: string): void {
        try {
            this.storage.setItem(key, value);
        } catch {
            /* retain the existing durable entry on storage failure */
        }
    }
    private remove(key: string): void {
        try {
            this.storage.removeItem(key);
        } catch {
            /* retain the existing durable entry on storage failure */
        }
    }
    private reclaimRedundantCache(): void {
        this.remove('dashboard-cache');
        const cache = parse(this.get('playerPreferences'));
        const dirty = parse(this.get(LEGACY_PREFERENCE_DIRTY_KEY));
        if (object(cache)) {
            const compact: Record<string, unknown> = {};
            for (const key of [
                'volume',
                'isMuted',
                CACHE_EPOCH_FIELD,
                ...(object(dirty)
                    ? Object.keys(dirty).filter((key) => this.allowedField(key))
                    : []),
            ])
                if (Object.hasOwn(cache, key)) compact[key] = cache[key];
            // A failed replacement leaves the original durable copy untouched.
            this.put('playerPreferences', JSON.stringify(compact));
        }
    }
    private ensureEpoch(recover = false): PreferenceEpoch {
        const existing = epochFrom(this.get(PREFERENCE_EPOCH_KEY));
        if (existing?.permit && !existing.retired && this.get(PREFERENCE_PERMIT_KEY) === '1')
            return existing;
        if (existing?.permit) {
            if (!recover) return existing; // Random recovery is published only under the origin bootstrap lock.
            // A missing permit retires even an otherwise unchanged full marker.
            // Commit a fresh higher generation BEFORE granting writes again.
            const restored = {
                id: identifier(),
                cleared: true,
                generation: generationAfter(Number(existing.generation)),
                permit: true,
            };
            const serialized = JSON.stringify(restored);
            this.put(PREFERENCE_EPOCH_KEY, serialized);
            if (this.get(PREFERENCE_EPOCH_KEY) === serialized) this.put(PREFERENCE_PERMIT_KEY, '1');
            return epochFrom(this.get(PREFERENCE_EPOCH_KEY)) ?? existing;
        }
        // Legacy markers gain the permit requirement without changing the ID
        // that tags their cache/journal values. Concurrent first allocations use
        // the same identity; grant the reserve BEFORE publishing that marker so
        // another first tab cannot mistake an intermediate state for retirement.
        const initial = existing
            ? { ...existing, permit: true }
            : {
                  id: '00000000-0000-0000-0000-000000000000',
                  cleared: false,
                  generation: '0000000000000001',
                  permit: true,
              };
        const serialized = JSON.stringify(initial);
        const allocate = (): void => {
            this.put(PREFERENCE_PERMIT_KEY, '1');
            if (this.get(PREFERENCE_PERMIT_KEY) === '1') this.put(PREFERENCE_EPOCH_KEY, serialized);
        };
        allocate();
        if (
            this.get(PREFERENCE_EPOCH_KEY) !== serialized ||
            this.get(PREFERENCE_PERMIT_KEY) !== '1'
        ) {
            // Preserve explicit legacy dirty values and local device volume/mute
            // while reclaiming redundant snapshots for the initial allocation.
            this.reclaimRedundantCache();
            const allocated = epochFrom(this.get(PREFERENCE_EPOCH_KEY));
            if (allocated?.permit) return allocated;
            allocate();
        }
        return epochFrom(this.get(PREFERENCE_EPOCH_KEY)) ?? initial;
    }
    isCurrent(): boolean {
        // Every read/cache/network boundary checks the durable permit too. Its
        // removal broadcasts retirement even when every setItem is denied.
        const current = epochFrom(this.get(PREFERENCE_EPOCH_KEY));
        return (
            this.get(PREFERENCE_PERMIT_KEY) === '1' &&
            !!current?.permit &&
            !current.retired &&
            current.id === this.epoch &&
            current.generation === this.account.generation
        );
    }
    refreshEpoch(): void {
        this.account = this.ensureEpoch();
    }
    /** Caller holds the constant origin bootstrap lock and explicitly initializes this account. */
    bootstrap(): boolean {
        this.account = this.ensureEpoch(true);
        return this.isCurrent();
    }
    browserIdentity(): string | undefined {
        if (!this.isCurrent()) return undefined;
        const value = this.get(PREFERENCE_BROWSER_ID_KEY);
        if (
            !value ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(value) ||
            (this.browserId && value !== this.browserId)
        )
            return undefined;
        this.browserId = value;
        return value;
    }
    /** Caller holds the same bootstrap lock; unrelated media allocators never write this key. */
    ensureBrowserIdentity(): string {
        if (!this.isCurrent()) throw new Error('Preference context retired');
        const stored = this.browserIdentity();
        if (stored) return stored;
        if (this.get(PREFERENCE_BROWSER_ID_KEY))
            throw new Error('Preference browser identity changed');
        const legacy = this.get('dashboard_device_id');
        const value =
            this.browserId ??
            (legacy && /^[A-Za-z0-9_-]{1,128}$/.test(legacy)
                ? legacy
                : `dashboard-${identifier()}`);
        this.put(PREFERENCE_BROWSER_ID_KEY, value);
        if (this.get(PREFERENCE_BROWSER_ID_KEY) !== value)
            throw new Error('Preference browser identity was not stored');
        this.browserId = value;
        return value;
    }

    /** Recover room for stable browser identity without discarding replay values. */
    recoverStorage(): void {
        if (this.isCurrent()) this.reclaimRedundantCache();
    }
    private entryKey(owner: string, id: string): string {
        return `${PREFERENCE_JOURNAL_PREFIX}${encodeURIComponent(this.epoch)}:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`;
    }
    /** Cache values and their epoch are one atomic localStorage write. */
    writeCache(key: string, value: Record<string, unknown>): void {
        if (!this.isCurrent()) return;
        this.put(key, JSON.stringify({ ...value, [CACHE_EPOCH_FIELD]: this.epoch }));
    }
    decodeCache(raw: string | null): Record<string, unknown> | undefined {
        if (!this.isCurrent()) return undefined;
        const value = parse(raw);
        if (!object(value)) return undefined;
        const tagged = Object.hasOwn(value, CACHE_EPOCH_FIELD);
        if (tagged ? value[CACHE_EPOCH_FIELD] !== this.epoch : this.cleared) return undefined;
        const result = { ...value };
        delete result[CACHE_EPOCH_FIELD];
        return result;
    }
    readCache(key: string): Record<string, unknown> | undefined {
        return this.decodeCache(this.get(key));
    }
    acknowledgements(): PreferenceFieldAcknowledgement[] {
        if (!this.isCurrent()) return [];
        const result: PreferenceFieldAcknowledgement[] = [];
        try {
            for (let i = 0; i < this.storage.length; i++) {
                const key = this.storage.key(i);
                if (!key?.startsWith(`${PREFERENCE_ACK_PREFIX}${encodeURIComponent(this.epoch)}:`))
                    continue;
                const value = parse(this.get(key));
                if (
                    object(value) &&
                    value.epoch === this.epoch &&
                    typeof value.field === 'string' &&
                    this.allowedField(value.field) &&
                    typeof value.updatedAt === 'number' &&
                    Number.isFinite(value.updatedAt) &&
                    typeof value.id === 'string' &&
                    Object.hasOwn(value, 'value')
                )
                    result.push({
                        epoch: this.epoch,
                        field: value.field,
                        value: value.value,
                        updatedAt: value.updatedAt,
                        id: value.id,
                    });
            }
        } catch {
            /* unavailable storage leaves edits durable */
        }
        return result;
    }
    acknowledged(field: string): PreferenceFieldAcknowledgement | undefined {
        return this.acknowledgements().find((entry) => entry.field === field);
    }
    entries(): PreferenceJournalEdit[] {
        if (!this.isCurrent()) return [];
        const keys: string[] = [];
        try {
            for (let i = 0; i < this.storage.length; i++) {
                const key = this.storage.key(i);
                if (key?.startsWith(PREFERENCE_JOURNAL_PREFIX)) keys.push(key);
            }
        } catch {
            return [];
        }
        const result: PreferenceJournalEdit[] = [];
        for (const storageKey of keys) {
            const serialized = this.get(storageKey);
            const value = parse(serialized);
            if (
                !serialized ||
                !object(value) ||
                value.epoch !== this.epoch ||
                typeof value.owner !== 'string' ||
                typeof value.id !== 'string' ||
                storageKey !== this.entryKey(value.owner, value.id) ||
                typeof value.field !== 'string' ||
                !this.allowedField(value.field) ||
                !Object.hasOwn(value, 'value') ||
                typeof value.revision !== 'number' ||
                !Number.isFinite(value.revision) ||
                typeof value.updatedAt !== 'number' ||
                !Number.isFinite(value.updatedAt)
            )
                continue;
            result.push({
                storageKey,
                serialized,
                epoch: this.epoch,
                owner: value.owner,
                id: value.id,
                field: value.field,
                value: value.value,
                revision: value.revision,
                updatedAt: value.updatedAt,
            });
        }
        const acknowledgements = this.acknowledgements();
        return result
            .filter((edit) => {
                const ack = acknowledgements.find((entry) => entry.field === edit.field);
                return (
                    !ack ||
                    edit.updatedAt > ack.updatedAt ||
                    (edit.updatedAt === ack.updatedAt && edit.id > ack.id)
                );
            })
            .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    record(field: string, value: unknown, revision: number): PreferenceJournalEdit | undefined {
        if (!this.isCurrent() || !this.allowedField(field)) return undefined;
        const existing = this.entries();
        let written: PreferenceJournalEdit | undefined;
        if (value !== undefined) {
            const id = this.newId();
            const entry = {
                epoch: this.epoch,
                owner: this.owner,
                id,
                field,
                value,
                revision,
                updatedAt: Math.max(
                    this.now(),
                    ...existing.map((edit) => edit.updatedAt + 1),
                    ...this.acknowledgements().map((ack) => ack.updatedAt + 1),
                ),
            };
            const serialized = JSON.stringify(entry);
            const storageKey = this.entryKey(this.owner, id);
            this.put(storageKey, serialized);
            // Never retire the previous durable value if storing its replacement failed.
            if (this.get(storageKey) !== serialized) return undefined;
            written = { ...entry, serialized, storageKey };
        }
        for (const edit of existing)
            if (edit.owner === this.owner && edit.field === field) this.remove(edit.storageKey);
        return written;
    }
    acknowledge(
        edits: readonly PreferenceJournalEdit[],
        payload?: Record<string, unknown>,
    ): boolean {
        if (!this.isCurrent()) return false;
        const winners = new Map<string, PreferenceJournalEdit>();
        for (const edit of edits) {
            if (edit.epoch !== this.epoch || !this.allowedField(edit.field)) continue;
            const previous = winners.get(edit.field);
            if (
                !previous ||
                edit.updatedAt > previous.updatedAt ||
                (edit.updatedAt === previous.updatedAt && edit.id > previous.id)
            )
                winners.set(edit.field, edit);
        }
        for (const [field, edit] of winners) {
            const previous = this.acknowledged(field);
            if (
                previous &&
                (previous.updatedAt > edit.updatedAt ||
                    (previous.updatedAt === edit.updatedAt && previous.id >= edit.id))
            )
                continue;
            const ack: PreferenceFieldAcknowledgement = {
                epoch: this.epoch,
                field,
                id: edit.id,
                updatedAt: edit.updatedAt,
                value: payload && Object.hasOwn(payload, field) ? payload[field] : edit.value,
            };
            const key = `${PREFERENCE_ACK_PREFIX}${encodeURIComponent(this.epoch)}:${encodeURIComponent(field)}`;
            const serialized = JSON.stringify(ack);
            this.put(key, serialized);
            if (this.get(key) !== serialized) return false;
        }
        for (const edit of edits) {
            if (edit.epoch === this.epoch && this.get(edit.storageKey) === edit.serialized)
                this.remove(edit.storageKey);
        }
        return true;
    }
    /** Legacy revisions are useful only with explicitly cached values from this account. */
    migrateLegacy(cacheKey: string): boolean {
        const raw = this.get(LEGACY_PREFERENCE_DIRTY_KEY);
        if (!raw) return true;
        if (!this.isCurrent()) return false;
        const dirty = parse(raw);
        const cached = this.readCache(cacheKey);
        let failed = false;
        if (object(dirty) && cached) {
            for (const [field, revision] of Object.entries(dirty)) {
                if (
                    typeof revision === 'number' &&
                    Number.isFinite(revision) &&
                    this.allowedField(field) &&
                    !this.acknowledged(field) &&
                    Object.hasOwn(cached, field) &&
                    cached[field] !== undefined
                ) {
                    if (!this.record(field, cached[field], revision)) failed = true;
                }
            }
        }
        if (!failed && this.get(LEGACY_PREFERENCE_DIRTY_KEY) === raw)
            this.remove(LEGACY_PREFERENCE_DIRTY_KEY);
        return !failed;
    }
}
