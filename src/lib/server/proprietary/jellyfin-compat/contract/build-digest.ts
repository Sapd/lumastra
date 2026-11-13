// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turns Jellyfin OpenAPI specs (one per jellyfin-sdk-kotlin release) into the
 * contract digest the /j validator checks against. The Kotlin generator makes a
 * property a required constructor parameter when it is not `nullable` and has no
 * `default` — that rule, unioned over SDK versions, is what "required" means here.
 */

export type JsonType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

interface SchemaObject {
    type?: string;
    format?: string;
    nullable?: boolean;
    default?: unknown;
    enum?: unknown[];
    $ref?: string;
    allOf?: SchemaObject[];
    oneOf?: SchemaObject[];
    items?: SchemaObject;
    properties?: Record<string, SchemaObject>;
    required?: string[];
}
export interface OpenApiDoc {
    info: { version: string };
    paths: Record<
        string,
        Record<
            string,
            { responses?: Record<string, { content?: Record<string, { schema?: SchemaObject }> }> }
        >
    >;
    components: { schemas: Record<string, SchemaObject> };
}
export interface PropertyContract {
    /** SDK versions where the property is non-nullable and has no default ([] = never required). */
    required: string[];
    /** Non-nullable WITH a default in every version that has it non-nullable. */
    hasDefault: boolean;
    /** Nullable in at least one version. */
    nullable: boolean;
    type?: JsonType;
    format?: 'int32' | 'int64' | 'uuid';
    /** Intersection across the versions that define the property. */
    enum?: string[];
    /** Schema name of the nested object / array items. */
    child?: string;
}
export interface ContractDigest {
    versions: { sdk: string; spec: string }[];
    schemas: Record<string, Record<string, PropertyContract>>;
    /** path = spec template; schema = component name, `Name[]` for array responses, null when no JSON body. */
    routes: { method: string; path: string; schema: string | null }[];
}
export interface SpecInput {
    sdk: string;
    spec: OpenApiDoc;
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;
const FORMATS = new Set(['int32', 'int64', 'uuid']);

function refName(ref: string | undefined): string | undefined {
    return ref?.startsWith('#/components/schemas/')
        ? ref.slice('#/components/schemas/'.length)
        : undefined;
}

/** The schema a property points at, looking through allOf/oneOf wrappers. */
function targetRef(p: SchemaObject): string | undefined {
    return refName(p.$ref) ?? refName(p.allOf?.[0]?.$ref) ?? refName(p.oneOf?.[0]?.$ref);
}

function resolveType(
    p: SchemaObject,
    schemas: Record<string, SchemaObject>,
): {
    type?: JsonType;
    enumValues?: string[];
    child?: string;
} {
    if (p.type === 'array') {
        const item = p.items ?? {};
        return { type: 'array', child: targetRef(item) };
    }
    const ref = targetRef(p);
    if (ref) {
        const target = schemas[ref];
        if (target?.enum) return { type: 'string', enumValues: target.enum.map(String) };
        return { type: 'object', child: ref };
    }
    if (p.enum) return { type: 'string', enumValues: p.enum.map(String) };
    const t = p.type as JsonType | undefined;
    return {
        type: t && ['string', 'integer', 'number', 'boolean', 'object'].includes(t) ? t : undefined,
    };
}

/** Route response schema name: `X` for an object, `X[]` for an array of X. */
function responseSchemaName(s: SchemaObject): string | null {
    if (s.type === 'array') {
        const item = s.items ? targetRef(s.items) : undefined;
        return item ? `${item}[]` : null;
    }
    return targetRef(s) ?? null;
}

export function buildDigest(inputs: SpecInput[]): ContractDigest {
    const schemas: ContractDigest['schemas'] = {};
    const routeMap = new Map<string, ContractDigest['routes'][number]>();
    // Track how many versions defined a property non-nullable, to decide hasDefault.
    const nonNullCount = new Map<string, number>();
    const defaultCount = new Map<string, number>();

    for (const { sdk, spec } of inputs) {
        for (const [schemaName, schema] of Object.entries(spec.components.schemas)) {
            if (!schema.properties) continue;
            const out = (schemas[schemaName] ??= {});
            for (const [prop, p] of Object.entries(schema.properties)) {
                const key = `${schemaName}.${prop}`;
                const nullable = p.nullable === true;
                const hasDefault = p.default !== undefined;
                const explicitlyRequired = schema.required?.includes(prop) ?? false;
                const { type, enumValues, child } = resolveType(p, spec.components.schemas);
                const existing = out[prop];
                const c: PropertyContract = existing ?? {
                    required: [],
                    hasDefault: false,
                    nullable: false,
                };
                if ((!nullable && !hasDefault) || (explicitlyRequired && !hasDefault))
                    c.required.push(sdk);
                if (!nullable) {
                    nonNullCount.set(key, (nonNullCount.get(key) ?? 0) + 1);
                    if (hasDefault) defaultCount.set(key, (defaultCount.get(key) ?? 0) + 1);
                }
                c.nullable ||= nullable;
                c.type ??= type;
                if (!c.format && p.format && FORMATS.has(p.format))
                    c.format = p.format as PropertyContract['format'];
                c.child ??= child;
                if (enumValues)
                    c.enum = c.enum
                        ? c.enum.filter((v) => enumValues.includes(v))
                        : [...enumValues];
                out[prop] = c;
            }
        }
        for (const [path, ops] of Object.entries(spec.paths)) {
            for (const m of HTTP_METHODS) {
                const op = ops[m];
                if (!op) continue;
                const ok = op.responses?.['200'];
                const schemaRef = ok?.content?.['application/json']?.schema;
                const schema = schemaRef ? responseSchemaName(schemaRef) : null;
                const k = `${m.toUpperCase()} ${path}`;
                if (!routeMap.has(k) || schema)
                    routeMap.set(k, { method: m.toUpperCase(), path, schema });
            }
        }
    }
    for (const [schemaName, props] of Object.entries(schemas)) {
        for (const [prop, c] of Object.entries(props)) {
            const key = `${schemaName}.${prop}`;
            const nn = nonNullCount.get(key) ?? 0;
            c.hasDefault = nn > 0 && (defaultCount.get(key) ?? 0) === nn;
        }
    }
    return {
        versions: inputs.map((i) => ({ sdk: i.sdk, spec: i.spec.info.version })),
        schemas,
        routes: [...routeMap.values()].sort((a, b) =>
            (a.path + a.method).localeCompare(b.path + b.method),
        ),
    };
}
