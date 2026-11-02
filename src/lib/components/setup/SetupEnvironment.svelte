<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  @component
  Install overview at the start of the setup wizard: which optional services are
  there (greyed out when not, with a link to set them up), storage, the live
  nodes as /admin/cluster lists them, and how requests reach the app (reverse
  proxy, HTTPS, platform). The slower half (ffmpeg) arrives as a streamed
  promise. Read-only; Recheck re-runs the page load, Copy puts a
  plain-text summary on the clipboard for a support request.
-->
<script lang="ts">
    import {
        Icon,
        ArrowPath,
        ArrowTopRightOnSquare,
        CheckCircle,
        ClipboardDocument,
        ExclamationTriangle,
        MinusCircle,
    } from 'svelte-hero-icons';
    import type {
        SetupEnvironment,
        SetupEnvironmentDetails,
        SetupEnvironmentNode,
    } from '$lib/shared/setup-environment';
    import { formatUptime } from '$lib/utils/metric-formatters';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        environment: SetupEnvironment;
        /** Streamed by the page load; resolves to null when it failed. */
        details?: Promise<SetupEnvironmentDetails | null> | null;
        /** Re-runs the page load. */
        onrecheck?: () => Promise<void>;
    }

    let { environment, details = null, onrecheck }: Props = $props();

    /** `on` = present, `warn` = configured but broken, `off` = absent (greyed out). */
    type RowState = 'on' | 'warn' | 'off';

    interface Row {
        id: string;
        label: string;
        value: string;
        state: RowState;
        /** Docs page for setting it up; shown only when the row is not `on`. */
        docs?: string;
    }

    const DOCS = 'https://lumastra.org/guides';
    const DOC = {
        valkey: `${DOCS}/deploy-docker/#production-valkey-layout`,
        sonic: `${DOCS}/deploy-docker/#sonic-embedder-sidecar`,
        gpu: `${DOCS}/gpu-transcoding/`,
        proxy: `${DOCS}/reverse-proxy/`,
        volumes: `${DOCS}/deploy-docker/#volumes`,
        worker: `${DOCS}/deploy-docker/#adding-a-dedicated-worker`,
        keys: `${DOCS}/configuration/#secrets-at-rest`,
        updates: `${DOCS}/zero-downtime-updates/`,
        liveTv: `${DOCS}/live-tv/`,
    };

    const GPU_LABELS: Record<string, string> = {
        nvenc: 'NVIDIA NVENC',
        qsv: 'Intel Quick Sync',
        vaapi: 'VAAPI',
        amf: 'AMD AMF',
        videotoolbox: 'VideoToolbox',
    };

    /** One row for a single instance; cache and tasks separately when TASK_CACHE_URL splits them. */
    function valkeyRows(s: SetupEnvironment['services']): Row[] {
        if (s.valkeyTasks === undefined) {
            return [
                {
                    id: 'valkey',
                    label: m.setup_env_valkey(),
                    value: s.valkey ? m.setup_env_valkey_single() : m.setup_env_valkey_down(),
                    state: s.valkey ? 'on' : 'warn',
                    docs: DOC.valkey,
                },
            ];
        }
        return [
            {
                id: 'valkey',
                label: m.setup_env_valkey_cache(),
                value: s.valkey ? m.setup_env_valkey_ok() : m.setup_env_valkey_down(),
                state: s.valkey ? 'on' : 'warn',
                docs: DOC.valkey,
            },
            {
                id: 'valkey-tasks',
                label: m.setup_env_valkey_tasks(),
                value: s.valkeyTasks ? m.setup_env_valkey_ok() : m.setup_env_valkey_tasks_down(),
                state: s.valkeyTasks ? 'on' : 'warn',
                docs: DOC.valkey,
            },
        ];
    }

    const services = $derived.by((): Row[] => {
        const s = environment.services;
        const sonic: Record<string, [string, RowState]> = {
            ready: [m.setup_env_sonic_ready(), 'on'],
            subprocess: [m.setup_env_sonic_subprocess(), 'on'],
            unreachable: [m.setup_env_sonic_unreachable(), 'warn'],
            absent: [m.setup_env_sonic_absent(), 'off'],
        };
        const [sonicValue, sonicState] = sonic[s.sonic] ?? sonic.absent;
        const liveTv: Record<string, [string, RowState]> = {
            ready: [m.setup_env_livetv_ready(), 'on'],
            unreachable: [m.setup_env_livetv_unreachable(), 'warn'],
            absent: [m.setup_env_livetv_absent(), 'off'],
        };
        const [liveTvValue, liveTvState] = liveTv[s.liveTvProxy] ?? liveTv.absent;
        const gpuOn = s.gpu !== 'none';
        const db = environment.database;
        const dbValue = [
            db.postgres
                ? m.setup_env_database_value({ version: db.postgres })
                : m.setup_env_database_unknown(),
            db.pgvector
                ? m.setup_env_pgvector({ version: db.pgvector })
                : m.setup_env_pgvector_missing(),
            db.pgvector && db.dimension
                ? m.setup_env_pgvector_dim({ dimension: String(db.dimension) })
                : null,
        ]
            .filter(Boolean)
            .join(' · ');
        return [
            {
                id: 'database',
                label: m.setup_env_database(),
                value: dbValue,
                state: db.pgvector ? 'on' : 'warn',
            },
            ...valkeyRows(s),
            {
                id: 'sonic',
                label: m.setup_env_sonic(),
                value: sonicValue,
                state: sonicState,
                docs: DOC.sonic,
            },
            {
                id: 'livetv',
                label: m.setup_env_livetv(),
                value: liveTvValue,
                state: liveTvState,
                docs: DOC.liveTv,
            },
            {
                id: 'gpu',
                label: m.setup_env_gpu(),
                value: !gpuOn
                    ? s.gpuDevice
                        ? m.setup_env_gpu_device()
                        : m.setup_env_gpu_off()
                    : s.gpu === 'other'
                      ? m.setup_env_gpu_other()
                      : m.setup_env_gpu_on({ mode: GPU_LABELS[s.gpu] ?? s.gpu }),
                state: gpuOn ? 'on' : 'off',
                docs: DOC.gpu,
            },
        ];
    });

    const storage = $derived.by((): Row[] => {
        const st = environment.storage;
        const config: Record<string, string> = {
            ok: m.setup_env_config_ok(),
            missing: m.setup_env_config_missing(),
            'not-writable': m.setup_env_config_not_writable(),
            'not-mounted': m.setup_env_config_not_mounted(),
        };
        const rows: Row[] = [
            {
                id: 'config',
                label: m.setup_env_config(),
                value: [config[st.config] ?? config.missing, st.configPath]
                    .filter(Boolean)
                    .join(' · '),
                state: st.config === 'ok' ? 'on' : 'warn',
                docs: DOC.volumes,
            },
        ];
        if (st.mounts) {
            rows.push({
                id: 'mounts',
                label: m.setup_env_mounts(),
                value: st.mounts.length > 0 ? st.mounts.join(', ') : m.setup_env_mounts_none(),
                state: st.mounts.length > 0 ? 'on' : 'warn',
                docs: DOC.volumes,
            });
        }
        return rows;
    });

    const network = $derived.by((): Row[] => {
        const n = environment.network;
        const proxy: Record<string, [string, RowState]> = {
            proxy: [m.setup_env_proxy_yes(), 'on'],
            'proxy-unpinned': [m.setup_env_proxy_unpinned(), 'warn'],
            'proxy-untrusted': [m.setup_env_proxy_untrusted(), 'warn'],
            direct: [m.setup_env_proxy_no(), 'off'],
        };
        const [proxyValue, proxyState] = proxy[n.proxy] ?? proxy.direct;
        const platform: Record<string, string> = {
            kubernetes: m.setup_env_platform_kubernetes(),
            docker: m.setup_env_platform_docker(),
            host: m.setup_env_platform_host(),
        };
        return [
            {
                id: 'proxy',
                label: m.setup_env_proxy(),
                value: proxyValue,
                state: proxyState,
                docs: DOC.proxy,
            },
            {
                id: 'https',
                label: m.setup_env_https(),
                value: !n.https
                    ? m.setup_env_https_no()
                    : n.proxy === 'direct'
                      ? m.setup_env_https_yes()
                      : m.setup_env_https_proxy(),
                state: n.https ? 'on' : 'off',
                docs: DOC.proxy,
            },
            {
                id: 'platform',
                label: m.setup_env_platform(),
                value: platform[n.platform] ?? n.platform,
                state: 'on',
            },
        ];
    });

    const clusterWarnings = $derived.by((): Row[] => {
        const c = environment.cluster;
        const rows: Row[] = [];
        if (c.keyMismatch) {
            rows.push({
                id: 'key-mismatch',
                label: '',
                value: m.setup_env_key_mismatch(),
                state: 'warn',
                docs: DOC.keys,
            });
        }
        if (c.versionMismatch) {
            rows.push({
                id: 'version-mismatch',
                label: '',
                value: m.setup_env_version_mismatch(),
                state: 'warn',
                docs: DOC.updates,
            });
        }
        if (c.noWorker) {
            rows.push({
                id: 'no-worker',
                label: '',
                value: m.setup_env_no_worker(),
                state: 'warn',
                docs: DOC.worker,
            });
        }
        return rows;
    });

    function detailRows(d: SetupEnvironmentDetails | null): Row[] {
        if (!d) return [];
        if (d.ffmpegPending) {
            return [
                {
                    id: 'ffmpeg',
                    label: m.setup_env_ffmpeg(),
                    value: m.setup_env_ffmpeg_pending(),
                    state: 'off',
                },
            ];
        }
        if (!d.ffmpeg) {
            return [
                {
                    id: 'ffmpeg',
                    label: m.setup_env_ffmpeg(),
                    value: m.setup_env_ffmpeg_missing(),
                    state: 'warn',
                    docs: DOC.gpu,
                },
            ];
        }
        const accel =
            d.ffmpeg.hwaccels.length > 0
                ? m.setup_env_ffmpeg_hwaccels({ list: d.ffmpeg.hwaccels.join(', ') })
                : m.setup_env_ffmpeg_no_hwaccels();
        return [
            {
                id: 'ffmpeg',
                label: m.setup_env_ffmpeg(),
                value: `${d.ffmpeg.version} · ${accel}`,
                state: 'on',
            },
        ];
    }

    const roleLabel = (role: SetupEnvironmentNode['role']): string =>
        ({
            web: m.setup_env_role_web(),
            worker: m.setup_env_role_worker(),
            proxy: m.setup_env_role_proxy(),
            general: m.setup_env_role_general(),
        })[role] ?? role;

    /** Heartbeats carry `v0.1.0` or a bare `16.300.0`; show one leading v either way. */
    const versionLabel = (version: string): string =>
        version ? `v${version.replace(/^v/i, '')}` : '';

    function formatBytes(bytes: number): string {
        const gb = bytes / 1024 ** 3;
        if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
        return `${Math.round(bytes / 1024 ** 2)} MB`;
    }

    function nodeMeta(node: SetupEnvironmentNode): string {
        return [
            node.host,
            versionLabel(node.version),
            m.setup_env_uptime({ duration: formatUptime(node.uptimeSeconds) }),
            node.memoryLimitBytes
                ? m.setup_env_node_memory({ size: formatBytes(node.memoryLimitBytes) })
                : null,
            node.cpuLimitCores
                ? m.setup_env_node_cpu({ cores: String(Math.round(node.cpuLimitCores * 10) / 10) })
                : null,
        ]
            .filter(Boolean)
            .join(' · ');
    }

    // Details resolved so far, for the copied summary.
    let resolvedDetails = $state<SetupEnvironmentDetails | null>(null);
    $effect(() => {
        resolvedDetails = null;
        const pending = details;
        if (!pending) return;
        let live = true;
        pending.then(
            (d) => {
                if (live) resolvedDetails = d;
            },
            () => undefined,
        );
        return () => {
            live = false;
        };
    });

    let rechecking = $state(false);

    async function recheck(): Promise<void> {
        if (!onrecheck || rechecking) return;
        rechecking = true;
        try {
            await onrecheck();
        } finally {
            rechecking = false;
        }
    }

    const MARK: Record<RowState, string> = { on: '[ok]', warn: '[!!]', off: '[--]' };

    /** Plain-text summary, for pasting into a bug report or support request. */
    function summaryText(): string {
        const line = (r: Row): string =>
            `${MARK[r.state]} ${r.label ? `${r.label}: ` : ''}${r.value}`;
        const section = (title: string, list: Row[]): string[] =>
            list.length > 0 ? ['', title, ...list.map(line)] : [];
        const nodeRows: Row[] = environment.nodes.map((n) => ({
            id: n.instanceId,
            label: `${n.instanceId} (${roleLabel(n.role)}${n.self ? `, ${m.setup_env_this_node()}` : ''})`,
            value: nodeMeta(n),
            state: 'on',
        }));
        return [
            m.setup_env_title(),
            ...section(m.setup_env_services(), [...services, ...detailRows(resolvedDetails)]),
            ...section(m.setup_env_storage(), storage),
            ...section(m.setup_env_network(), network),
            ...section(m.setup_env_nodes(), [...nodeRows, ...clusterWarnings]),
        ].join('\n');
    }

    async function copySummary(): Promise<void> {
        try {
            await navigator.clipboard.writeText(summaryText());
            toasts.success(m.setup_env_copied());
        } catch {
            toasts.error(m.setup_env_copy_failed());
        }
    }

    const ICONS = { on: CheckCircle, warn: ExclamationTriangle, off: MinusCircle };
</script>

{#snippet rowItem(row: Row)}
    <li class="env-row env-{row.state}" data-testid="setup-env-{row.id}">
        <Icon src={ICONS[row.state]} class="h-4 w-4 shrink-0 env-icon" />
        {#if row.label}<span class="env-label">{row.label}</span>{/if}
        <span class="env-value">
            <span class="env-text">{row.value}</span>
            {#if row.docs && row.state !== 'on'}
                <a class="env-docs" href={row.docs} target="_blank" rel="noopener noreferrer"
                    >{m.setup_env_how_to()}<Icon src={ArrowTopRightOnSquare} class="h-3 w-3" /></a>
            {/if}
        </span>
    </li>
{/snippet}

{#snippet rows(list: Row[])}
    <ul class="env-rows">
        {#each list as row (row.id)}
            {@render rowItem(row)}
        {/each}
    </ul>
{/snippet}

<section class="env" aria-labelledby="setup-env-title">
    <div class="env-head">
        <h2 id="setup-env-title" class="env-title">{m.setup_env_title()}</h2>
        <div class="env-actions">
            <button type="button" class="env-action" onclick={copySummary}>
                <Icon src={ClipboardDocument} class="h-4 w-4" />
                <span>{m.setup_env_copy()}</span>
            </button>
            {#if onrecheck}
                <button
                    type="button"
                    class="env-action"
                    onclick={recheck}
                    disabled={rechecking}
                    aria-busy={rechecking}>
                    <Icon src={ArrowPath} class="h-4 w-4 {rechecking ? 'animate-spin' : ''}" />
                    <span>{m.setup_env_recheck()}</span>
                </button>
            {/if}
        </div>
    </div>

    <div class="env-grid">
        <div>
            <h3 class="env-group">{m.setup_env_services()}</h3>
            <ul class="env-rows">
                {#each services as row (row.id)}
                    {@render rowItem(row)}
                {/each}
                {#if details}
                    {#await details}
                        <li class="env-row env-pending" data-testid="setup-env-checking">
                            <span class="loading-spinner env-spinner"></span>
                            <span class="env-value">{m.setup_env_checking()}</span>
                        </li>
                    {:then d}
                        {#each detailRows(d) as row (row.id)}
                            {@render rowItem(row)}
                        {/each}
                    {/await}
                {/if}
            </ul>
        </div>
        <div>
            <h3 class="env-group">{m.setup_env_network()}</h3>
            {@render rows(network)}
            <h3 class="env-group">{m.setup_env_storage()}</h3>
            {@render rows(storage)}
        </div>
    </div>

    <h3 class="env-group">{m.setup_env_nodes()}</h3>
    {#if environment.nodes.length === 0}
        <p class="env-empty">{m.setup_env_nodes_empty()}</p>
    {:else}
        <ul class="env-nodes">
            {#each environment.nodes as node (node.instanceId)}
                <li class="env-node" data-testid="setup-env-node">
                    <span class="env-role env-role-{node.role}">{roleLabel(node.role)}</span>
                    <span class="env-node-name">
                        {node.instanceId}
                        {#if node.self}<span class="env-self">· {m.setup_env_this_node()}</span
                            >{/if}
                    </span>
                    <span class="env-node-meta">{nodeMeta(node)}</span>
                </li>
            {/each}
        </ul>
    {/if}
    {#if clusterWarnings.length > 0}
        <div class="env-cluster-warnings">{@render rows(clusterWarnings)}</div>
    {/if}
</section>

<style>
    .env {
        margin-top: 1.25rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.4);
        background: rgb(var(--color-surface-700-rgb) / 0.4);
        border-radius: 0.75rem;
        padding: 0.9rem 1rem;
        font-size: 0.85rem;
    }

    .env-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .env-title {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
        color: rgb(var(--color-surface-100-rgb));
    }

    .env-actions {
        display: flex;
        gap: 0.75rem;
    }

    .env-action {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.8rem;
        font-weight: 600;
        color: rgb(var(--color-surface-300-rgb));
        cursor: pointer;
    }

    .env-action:hover {
        color: rgb(var(--color-surface-100-rgb));
    }

    .env-action:disabled {
        opacity: 0.6;
        cursor: default;
    }

    .env-action:focus-visible,
    .env-docs:focus-visible {
        outline: 2px solid rgb(var(--color-primary-400-rgb));
        outline-offset: 2px;
        border-radius: 0.25rem;
    }

    .env-empty {
        margin: 0.25rem 0 0;
        color: rgb(var(--color-surface-300-rgb));
    }

    .env-grid {
        display: grid;
        gap: 0 1.5rem;
        grid-template-columns: 1fr;
    }

    @media (min-width: 640px) {
        .env-grid {
            grid-template-columns: 1fr 1fr;
        }
    }

    .env-group {
        margin: 0.9rem 0 0.35rem;
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: rgb(var(--color-surface-400-rgb));
    }

    .env-rows,
    .env-nodes {
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 0.4rem;
    }

    .env-row {
        display: grid;
        grid-template-columns: auto 1fr;
        column-gap: 0.45rem;
        align-items: start;
    }

    .env-row :global(.env-icon),
    .env-spinner {
        margin-top: 0.1rem;
        grid-row: span 2;
    }

    .env-spinner {
        width: 1rem;
        height: 1rem;
    }

    .env-label {
        font-weight: 600;
        color: rgb(var(--color-surface-100-rgb));
    }

    .env-value {
        grid-column: 2;
        color: rgb(var(--color-surface-300-rgb));
        line-height: 1.35;
        overflow-wrap: anywhere;
    }

    /* Its own line under the explanation, so it never wraps mid-sentence. */
    .env-docs {
        display: flex;
        width: fit-content;
        align-items: center;
        gap: 0.25rem;
        margin-top: 0.15rem;
        font-size: 0.8rem;
        font-weight: 500;
        color: rgb(var(--color-primary-400-rgb));
        text-decoration: none;
    }

    .env-docs:hover {
        text-decoration: underline;
    }

    .env-on :global(.env-icon) {
        color: rgb(var(--color-success-400-rgb));
    }

    .env-warn :global(.env-icon) {
        color: rgb(var(--color-warning-400-rgb));
    }

    /* Absent: greyed out, still readable; the setup link keeps full strength. */
    .env-off .env-label,
    .env-off .env-text,
    .env-off :global(.env-icon) {
        opacity: 0.55;
    }

    .env-off :global(.env-icon) {
        color: rgb(var(--color-surface-400-rgb));
    }

    .env-cluster-warnings {
        margin-top: 0.6rem;
    }

    .env-node {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.25rem 0.5rem;
    }

    .env-node-name {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: rgb(var(--color-surface-100-rgb));
        overflow-wrap: anywhere;
    }

    .env-self {
        font-family: inherit;
        color: rgb(var(--color-primary-400-rgb));
    }

    .env-node-meta {
        color: rgb(var(--color-surface-400-rgb));
        overflow-wrap: anywhere;
    }

    .env-role {
        font-size: 0.7rem;
        font-weight: 600;
        border-radius: 999px;
        padding: 0.05rem 0.5rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.4);
        background: rgb(var(--color-surface-500-rgb) / 0.2);
        color: rgb(var(--color-surface-200-rgb));
    }

    .env-role-web {
        border-color: rgb(59 130 246 / 0.35);
        background: rgb(59 130 246 / 0.18);
        color: rgb(147 197 253);
    }

    .env-role-worker {
        border-color: rgb(168 85 247 / 0.35);
        background: rgb(168 85 247 / 0.18);
        color: rgb(216 180 254);
    }

    .env-role-proxy {
        border-color: rgb(245 158 11 / 0.35);
        background: rgb(245 158 11 / 0.18);
        color: rgb(252 211 77);
    }
</style>
