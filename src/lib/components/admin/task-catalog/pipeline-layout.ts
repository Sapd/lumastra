// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pipeline layout — translates a flat task list into a dagre-laid-out DAG.
 *
 * Why client-side: pipelines are small (~3–8 stages typically; ~30 tasks
 * total). Computing the layout in the browser keeps the backend stateless
 * and the layout helper unit-testable as a pure function.
 *
 * Topology rules:
 *   - The "root" is the task whose id === `rootId` (the pipeline.of value).
 *     There may or may not be a registered task with that exact id; if there
 *     is none, the layout still works — root is implicit and we treat the
 *     set of pipeline members whose `pipeline.after` is empty as the entry
 *     points.
 *   - Multi-parent fan-in (`pipeline.after.length > 1`) is represented with
 *     a synthetic `__gate__<taskId>` node inserted in front of the
 *     convergent task. The synthesis mirrors `pipeline-builder.ts` server-side
 *     so admins can debug the real BullMQ FlowProducer topology.
 *   - Cycles are not expected (the registry rejects them on load) but if
 *     somehow present, dagre still produces a layout — we don't crash.
 *
 * Coordinate convention: dagre puts `x,y` at node CENTERS. The renderer
 * subtracts width/2 and height/2 to get the top-left for absolute positioning.
 */

import dagre from '@dagrejs/dagre';
import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';

// Visual dimensions — kept here as the single source of truth. Changing
// these requires no other edits; the renderer reads `node.width`/`height`.
export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 72;
export const GATE_WIDTH = 56;
export const GATE_HEIGHT = 24;

// Dagre spacing — calibrated against the Lumastra admin aesthetic (compact
// but not cramped; ranksep > nodesep because top-down chains read better
// with more vertical breathing room than horizontal).
const NODESEP = 36;
const RANKSEP = 56;
const EDGESEP = 16;
const MARGINX = 24;
const MARGINY = 24;

export interface LaidOutNode {
    /** Stable id — for real tasks, the task id; for gates, `__gate__<convergentTaskId>`. */
    id: string;
    /** Top-left X (already subtracted from dagre's center). */
    x: number;
    /** Top-left Y. */
    y: number;
    width: number;
    height: number;
    /** True for synthetic fan-in markers. */
    isGate: boolean;
    /** Populated for non-gate nodes only. */
    task?: TaskDefinitionSummary;
}

export interface LaidOutEdge {
    /** Source node id (may be a gate id). */
    from: string;
    /** Target node id. */
    to: string;
    /** Dagre's polyline control points (CENTER coordinates), used to draw the SVG path. */
    points: Array<{ x: number; y: number }>;
}

export interface LaidOutPipeline {
    /** Overall SVG/canvas width in px. */
    width: number;
    /** Overall SVG/canvas height in px. */
    height: number;
    nodes: LaidOutNode[];
    edges: LaidOutEdge[];
    /** Members of the pipeline keyed by id, for component lookups. */
    members: TaskDefinitionSummary[];
}

/**
 * Determine the canonical pipeline root id given the current task.
 *
 * - If the task has `pipeline.of`, that string is the root.
 * - Otherwise, the task is itself the root (its id is what other members
 *   declare via `pipeline.of`).
 */
export function resolvePipelineRootId(task: TaskDefinitionSummary): string {
    return task.pipeline?.of ?? task.id;
}

/**
 * Collect every task that belongs to the pipeline rooted at `rootId`.
 *
 * Inclusion rule: `task.pipeline?.of === rootId` OR `task.id === rootId`.
 * The latter covers the case where the trigger task is itself a member
 * (which is the common pattern — see file-system-scan-discover).
 */
export function collectPipelineMembers(
    rootId: string,
    allTasks: readonly TaskDefinitionSummary[],
): TaskDefinitionSummary[] {
    return allTasks.filter((t) => t.pipeline?.of === rootId || t.id === rootId);
}

/**
 * Lay out a pipeline using dagre.
 *
 * Returns `null` if there are no members — caller should render an empty
 * state rather than an empty canvas.
 */
export function layoutPipeline(
    rootId: string,
    allTasks: readonly TaskDefinitionSummary[],
): LaidOutPipeline | null {
    const members = collectPipelineMembers(rootId, allTasks);
    if (members.length === 0) return null;

    const memberIds = new Set(members.map((m) => m.id));
    const g = new dagre.graphlib.Graph({ multigraph: false, compound: false });
    g.setGraph({
        rankdir: 'TB',
        nodesep: NODESEP,
        edgesep: EDGESEP,
        ranksep: RANKSEP,
        marginx: MARGINX,
        marginy: MARGINY,
        ranker: 'network-simplex',
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Real task nodes.
    for (const t of members) {
        g.setNode(t.id, {
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
        });
    }

    // Track gate ids so the consumer can identify them after layout.
    const gateIds = new Set<string>();

    // Edges. For each task with `pipeline.after`, draw an edge from each
    // parent → this task. If there are 2+ parents, insert a synthetic gate
    // node and route all parents through it.
    for (const t of members) {
        const declaredParents = t.pipeline?.after ?? [];
        // Drop self-references (would produce a dagre self-loop that lays out
        // as a degenerate edge through the node center) and dangling parents
        // not in the member set (typo in pipeline.after, or pipeline.after
        // referencing a task that didn't load). Warn so operators looking at
        // the admin visualiser can spot the registry inconsistency.
        const parents: string[] = [];
        for (const p of declaredParents) {
            if (p === t.id) {
                console.warn(
                    `[pipeline-layout] task '${t.id}' declares itself as a parent (self-reference) — edge skipped.`,
                );
                continue;
            }
            if (!memberIds.has(p)) {
                console.warn(
                    `[pipeline-layout] task '${t.id}' declares parent '${p}' which is not a member of pipeline '${rootId}' — edge skipped.`,
                );
                continue;
            }
            parents.push(p);
        }
        if (parents.length === 0) continue;

        if (parents.length === 1) {
            g.setEdge(parents[0], t.id);
            continue;
        }

        // Multi-parent: synthesize gate.
        const gateId = `__gate__${t.id}`;
        gateIds.add(gateId);
        g.setNode(gateId, { width: GATE_WIDTH, height: GATE_HEIGHT });
        for (const p of parents) {
            g.setEdge(p, gateId);
        }
        g.setEdge(gateId, t.id);
    }

    dagre.layout(g);

    const memberById = new Map(members.map((m) => [m.id, m]));

    const nodes: LaidOutNode[] = g.nodes().map((id) => {
        const n = g.node(id);
        const isGate = gateIds.has(id);
        // Dagre stores x/y at center; convert to top-left.
        return {
            id,
            x: n.x - n.width / 2,
            y: n.y - n.height / 2,
            width: n.width,
            height: n.height,
            isGate,
            task: isGate ? undefined : memberById.get(id),
        };
    });

    const edges: LaidOutEdge[] = g.edges().map((e) => {
        const edgeData = g.edge(e);
        return {
            from: e.v,
            to: e.w,
            points: edgeData.points.map((p: { x: number; y: number }) => ({
                x: p.x,
                y: p.y,
            })),
        };
    });

    const graphSize = g.graph();
    return {
        width: graphSize.width ?? 0,
        height: graphSize.height ?? 0,
        nodes,
        edges,
        members,
    };
}

/**
 * Convert a polyline of points into a smooth SVG path string using a simple
 * cubic-bezier approximation through each interior segment.
 *
 * Catmull-Rom → Bezier on a per-segment basis. The first and last segments
 * use the endpoints as their own control points so the path starts and
 * ends exactly at the node borders (where dagre put them).
 */
export function pointsToBezierPath(points: ReadonlyArray<{ x: number; y: number }>): string {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x},${points[0].y}`;
    if (points.length === 2) {
        // Single straight segment.
        return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`;
    }

    let d = `M ${points[0].x},${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] ?? points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] ?? p2;

        // Catmull-Rom tension 0.5 → cubic Bezier control points.
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;

        d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
    }
    return d;
}
