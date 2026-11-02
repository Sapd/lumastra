<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { SvelteMap } from 'svelte/reactivity';
    import { Icon, PlayCircle } from 'svelte-hero-icons';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import { modals } from '$lib/stores/modal.store';
    import * as playbackApi from '$lib/api/playback';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import type { StreamSession } from '$lib/schemas/api-playback-responses';

    interface Props {
        /** Current viewer's internal user id — used to scope streams to "my own". */
        viewerUserId?: string | undefined;
    }
    let { viewerUserId }: Props = $props();

    let sessions = $state<StreamSession[]>([]);
    let stoppingAll = $state(false);

    // A native Jellyfin session (`sessionSource === 'jellyfin'`) is only a mirror
    // of playback happening directly in a Jellyfin app — Lumastra polls it but
    // does not serve it, so `cancelSession` would flip our mirror row to KILLED
    // without stopping the actual playback (and the next poll resurrects it).
    // Those sessions must NOT expose a Stop control — it would be a silent no-op.
    //
    // `isReadOnly` says the same thing for the other mirror we merge: a direct
    // AudiobookShelf app listener, who has no play_sessions row for us to cancel
    // at all. It is a separate flag rather than another sessionSource check
    // because a book streamed THROUGH Lumastra carries sessionSource
    // 'audiobookshelf' too, and that one IS stoppable.
    function canStop(session: StreamSession): boolean {
        return session.sessionSource !== 'jellyfin' && !session.isReadOnly;
    }
    const stoppableSessions = $derived(sessions.filter(canStop));

    // Recently-stopped session ids (with stop timestamp) — guards against the
    // server's ~2s single-flight active-sessions cache resurrecting a
    // just-stopped session in a concurrent poll response (other tab, SSR, AI
    // assistant tool). Entries expire after 5s — longer than the cache TTL —
    // via pruneRecentlyStopped().
    const RECENTLY_STOPPED_TTL_MS = 5000;
    const recentlyStopped = new SvelteMap<string, number>();

    function pruneRecentlyStopped(): void {
        const now = Date.now();
        for (const [id, ts] of recentlyStopped) {
            if (now - ts > RECENTLY_STOPPED_TTL_MS) recentlyStopped.delete(id);
        }
    }

    function markRecentlyStopped(id: string): void {
        pruneRecentlyStopped();
        recentlyStopped.set(id, Date.now());
    }

    function subtitle(session: StreamSession): string {
        if (session.mediaType === 'episode' && session.seriesName) {
            const parts = [session.seriesName];
            if (session.seasonNumber != null && session.episodeNumber != null) {
                parts.push(`S${session.seasonNumber}E${session.episodeNumber}`);
            }
            return parts.join(' · ');
        }
        return '';
    }

    /**
     * Where it is playing: "Lumastra · Chrome", "Swiftfin · Apple TV".
     *
     * `clientname` is REDACTED (not unknown) when the viewer may not see device
     * info — see ActiveSessionSchema. Absence means "you are not permitted to
     * see this", so the line is simply empty; a filler like 'Unknown device'
     * would state a falsehood about the session. On this page the viewer only
     * ever sees their own streams, so in practice it is present.
     */
    function playingOn(session: StreamSession): string {
        const app = session.clientApp || session.clientname;
        const device = session.browsername;
        if (app && device && app !== device) return `${app} · ${device}`;
        return app || device || '';
    }

    /** 0–100, or null when the session has not reported a position yet. */
    function progress(session: StreamSession): number | null {
        if (typeof session.streamProgress === 'number' && Number.isFinite(session.streamProgress)) {
            return Math.max(0, Math.min(100, session.streamProgress));
        }
        const cur = session.playCurrentTime;
        const dur = session.playItemDuration;
        if (Number.isFinite(cur) && Number.isFinite(dur) && (dur as number) > 0) {
            return Math.max(0, Math.min(100, ((cur as number) / (dur as number)) * 100));
        }
        return null;
    }

    // Same pattern as LiveSessionSection's stop-stream flow: confirm dialog
    // routed through the shared modal store (matches every other ConfirmModal
    // call site — it has no backdrop/positioning of its own and relies on
    // ModalContainer to render it).
    async function stopSession(session: StreamSession): Promise<void> {
        try {
            // `__id` is the bare play_sessions UUID — do NOT use `playSessionId`
            // (that is `sourceSessionId`, a different value).
            const result = await playbackApi.cancelSession(session.__id);
            // A 404 means the session is already gone — another tab/admin/the
            // reconciler beat us to it, or the poll hasn't dropped the card
            // yet (TOCTOU). Treat that exactly like a successful stop instead
            // of surfacing an error toast.
            if (result.error && result.status !== 404) throw new Error(result.error);
            markRecentlyStopped(session.__id);
            // Optimistic remove; the poll interval reconciles regardless.
            sessions = sessions.filter((s) => s.__id !== session.__id);
            toasts.success(m.session_stop_success());
        } catch {
            toasts.error(m.session_stop_error());
            void loadSessions();
        }
    }

    function requestStopSession(session: StreamSession): void {
        modals.open(ConfirmModal, {
            title: m.session_stop_confirm_title(),
            body: m.session_stop_confirm_body(),
            confirmText: m.session_stop_confirm_button(),
            confirmVariant: 'danger' as const,
            onConfirm: () => stopSession(session),
        });
    }

    async function stopAllStreams(): Promise<void> {
        if (stoppingAll || stoppableSessions.length === 0) return;
        stoppingAll = true;
        // Skip native Jellyfin mirror sessions — cancelSession can't stop them.
        const targets = stoppableSessions.slice();
        let failures = 0;
        for (const session of targets) {
            try {
                const result = await playbackApi.cancelSession(session.__id);
                // 404 = already gone (TOCTOU) — treat as success, not a failure.
                if (result.error && result.status !== 404) throw new Error(result.error);
                markRecentlyStopped(session.__id);
                sessions = sessions.filter((s) => s.__id !== session.__id);
            } catch {
                failures += 1;
            }
        }
        stoppingAll = false;
        if (failures === 0) {
            toasts.success(m.session_stop_success());
        } else {
            toasts.error(m.session_stop_error());
            void loadSessions();
        }
    }

    function requestStopAll(): void {
        modals.open(ConfirmModal, {
            title: m.settings_active_streams_heading(),
            body: m.session_stop_confirm_body(),
            confirmText: m.settings_stop_all_streams(),
            confirmVariant: 'danger' as const,
            onConfirm: stopAllStreams,
        });
    }

    async function loadSessions(): Promise<void> {
        if (!viewerUserId) {
            sessions = [];
            return;
        }
        try {
            const result = await playbackApi.getActiveSessions('mine');
            if (result.error) return;
            const items = result.data?.items ?? [];
            // Drop any session we just stopped ourselves that the server's short-lived
            // active-sessions cache may still be echoing back (see recentlyStopped above).
            pruneRecentlyStopped();
            sessions = items.filter(
                (s) => s.userId === viewerUserId && !recentlyStopped.has(s.__id),
            );
        } catch {
            // keep last-known state; the poll interval retries
        }
    }

    onMount(() => {
        void loadSessions();
        const interval = setInterval(() => {
            if (document.hidden) return;
            void loadSessions();
        }, 5000);
        return () => clearInterval(interval);
    });
</script>

<SettingsGroup label={m.settings_active_streams_heading()}>
    {#snippet actions()}
        {#if stoppableSessions.length > 1}
            <button
                class="btn btn-sm variant-ghost-error"
                disabled={stoppingAll}
                onclick={requestStopAll}>
                {m.settings_stop_all_streams()}
            </button>
        {/if}
    {/snippet}
    {#if sessions.length === 0}
        <p class="flex items-center gap-3 py-3 px-4 text-sm text-surface-400">
            <Icon src={PlayCircle} class="w-6 h-6 shrink-0" />
            {m.settings_active_streams_none()}
        </p>
    {:else}
        {#each sessions as session (session.__id)}
            {@const sub = subtitle(session)}
            {@const where = playingOn(session)}
            {@const pct = progress(session)}
            <div class="flex flex-wrap items-center justify-between py-3 px-4 gap-x-4 gap-y-2">
                <div class="flex items-center gap-3 min-w-0 flex-1 basis-56">
                    <Icon src={PlayCircle} class="w-6 h-6 text-surface-400 shrink-0" />
                    <div class="min-w-0 flex-1">
                        <p class="text-sm font-medium truncate">{session.title}</p>
                        {#if sub || where || session.playIsPlaying === false}
                            <p class="text-xs text-surface-400 mt-0.5 truncate">
                                {[
                                    sub,
                                    where ? m.settings_active_streams_on({ device: where }) : '',
                                    session.playIsPlaying === false
                                        ? m.settings_active_streams_paused()
                                        : '',
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </p>
                        {/if}
                        {#if pct !== null}
                            <div
                                class="mt-2 h-1 rounded-full bg-surface-700 overflow-hidden max-w-xs"
                                role="progressbar"
                                aria-label={m.settings_active_streams_progress()}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(pct)}>
                                <div class="h-full bg-primary-500" style="width: {pct}%"></div>
                            </div>
                        {/if}
                    </div>
                </div>
                {#if canStop(session)}
                    <button
                        class="btn btn-sm variant-ghost-error shrink-0"
                        aria-label={m.settings_active_streams_stop_label({ title: session.title })}
                        onclick={() => requestStopSession(session)}>
                        {m.session_stop_stream()}
                    </button>
                {:else}
                    <span class="text-xs text-surface-500 shrink-0 max-w-48"
                        >{m.session_stop_jellyfin_native()}</span>
                {/if}
            </div>
        {/each}
    {/if}
</SettingsGroup>
