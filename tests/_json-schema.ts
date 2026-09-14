// The subset of JSON Schema (draft 2020-12 as OpenAPI 3.1 uses it) that packages/core/api-contract/openapi.json
// needs, written here so the contract tests carry no dependency: object (properties, required,
// additionalProperties, propertyNames), type (single or list, integer included), enum, const, anyOf, oneOf, allOf,
// $ref to a local JSON pointer, array (items, prefixItems, minItems, maxItems), numeric bounds, string bounds and
// pattern, and OpenAPI 3.0's nullable. Any other keyword that could change what validates makes the validator
// throw, so a document that starts using one fails the test instead of passing unchecked; annotation keywords
// (description, title, examples, x-...) are ignored.
export interface SchemaIssue {
  /** JSON pointer-like path into the value, "" for the root. */
  readonly path: string;
  readonly message: string;
}

type Schema = Record<string, unknown>;

/** Keywords that never affect validation. */
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly', '$schema', '$id', '$comment', 'format', 'discriminator', 'externalDocs']);
/** Keywords this validator implements. */
const SUPPORTED = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'nullable',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    default:
      throw new Error(`unsupported JSON Schema type ${JSON.stringify(type)}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Resolve a local JSON pointer reference (#/components/schemas/X) against the document. */
export function resolveRef(ref: string, root: unknown): Schema {
  if (!ref.startsWith('#/')) throw new Error(`only local $ref values are supported, got ${JSON.stringify(ref)}`);
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObject(node)) node = node[key];
    else node = undefined;
    if (node === undefined) throw new Error(`$ref ${JSON.stringify(ref)} does not resolve`);
  }
  if (!isObject(node)) throw new Error(`$ref ${JSON.stringify(ref)} does not point at a schema object`);
  return node;
}

function asSchema(v: unknown, where: string): Schema | boolean {
  if (typeof v === 'boolean') return v;
  if (!isObject(v)) throw new Error(`expected a schema at ${where}`);
  return v;
}

/**
 * Validate `value` against `schema`; `root` is the document $ref values resolve against (the schema itself when
 * omitted). Returns every issue found, empty when the value conforms.
 */
export function validateSchema(schema: unknown, value: unknown, root?: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  walk(asSchema(schema, 'root'), value, '', root ?? schema, issues, 0);
  return issues;
}

function walk(schema: Schema | boolean, value: unknown, path: string, root: unknown, issues: SchemaIssue[], depth: number): void {
  if (depth > 64) throw new Error(`schema nesting deeper than 64 at ${path || '/'}`);
  if (schema === true) return;
  if (schema === false) {
    issues.push({ path, message: 'no value is allowed here' });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (SUPPORTED.has(key) || ANNOTATIONS.has(key) || key.startsWith('x-')) continue;
    throw new Error(`unsupported JSON Schema keyword ${JSON.stringify(key)} at ${path || '/'}; extend tests/_json-schema.ts`);
  }
  const fail = (message: string) => issues.push({ path, message });

  if (typeof schema.$ref === 'string') walk(resolveRef(schema.$ref, root), value, path, root, issues, depth + 1);

  if (schema.nullable === true && value === null) return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.every((t): t is string => typeof t === 'string')) throw new Error(`type must be a string or a list of strings at ${path || '/'}`);
    if (!types.some((t) => matchesType(value, t))) fail(`expected type ${types.join(' | ')}, got ${typeOf(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) fail(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  if ('const' in schema && !deepEqual(schema.const, value)) fail(`expected the constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);

  if (Array.isArray(schema.anyOf)) {
    const passing = schema.anyOf.filter((s) => validateBranch(s, value, path, root, depth)).length;
    if (passing === 0) fail(`matched none of ${schema.anyOf.length} anyOf branches`);
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter((s) => validateBranch(s, value, path, root, depth)).length;
    if (passing !== 1) fail(`matched ${passing} of ${schema.oneOf.length} oneOf branches, expected exactly one`);
  }
  if (Array.isArray(schema.allOf)) for (const [i, s] of schema.allOf.entries()) walk(asSchema(s, `${path}/allOf/${i}`), value, path, root, issues, depth + 1);

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`${value} is below the minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`${value} is above the maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(`${value} is not above the exclusive minimum ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(`${value} is not below the exclusive maximum ${schema.exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(`shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(`longer than maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) fail(`${JSON.stringify(value)} does not match the pattern ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [i, s] of prefix.entries()) if (i < value.length) walk(asSchema(s, `${path}/prefixItems/${i}`), value[i], `${path}/${i}`, root, issues, depth + 1);
    if (schema.items !== undefined) {
      const items = asSchema(schema.items, `${path}/items`);
      for (let i = prefix.length; i < value.length; i += 1) walk(items, value[i], `${path}/${i}`, root, issues, depth + 1);
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`${value.length} items, fewer than minItems ${schema.minItems}`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`${value.length} items, more than maxItems ${schema.maxItems}`);
  }
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const r of schema.required) if (typeof r === 'string' && !(r in value)) fail(`missing required property ${JSON.stringify(r)}`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) walk(asSchema(props[k], `${path}/properties/${k}`), v, `${path}/${k}`, root, issues, depth + 1);
      else if (schema.additionalProperties === false) fail(`unexpected property ${JSON.stringify(k)}`);
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) walk(asSchema(schema.additionalProperties, `${path}/additionalProperties`), v, `${path}/${k}`, root, issues, depth + 1);
      if (schema.propertyNames !== undefined) walk(asSchema(schema.propertyNames, `${path}/propertyNames`), k, `${path}/${k} (name)`, root, issues, depth + 1);
    }
  }
}

function validateBranch(schema: unknown, value: unknown, path: string, root: unknown, depth: number): boolean {
  const issues: SchemaIssue[] = [];
  walk(asSchema(schema, `${path}/branch`), value, path, root, issues, depth + 1);
  return issues.length === 0;
}

/** The schema of the 200 application/json body of GET <route> in an OpenAPI document, e.g. responseSchema(doc, '/markets'). */
export function responseSchema(doc: unknown, route: string): Schema {
  if (!isObject(doc) || !isObject(doc.paths)) throw new Error('not an OpenAPI document: no paths');
  const op = isObject(doc.paths[route]) ? (doc.paths[route] as Record<string, unknown>).get : undefined;
  if (!isObject(op)) throw new Error(`no GET ${route} in the document`);
  const responses = isObject(op.responses) ? op.responses : {};
  const ok = isObject(responses['200']) ? responses['200'] : undefined;
  const content = ok && isObject(ok.content) ? ok.content : undefined;
  const json = content && isObject(content['application/json']) ? content['application/json'] : undefined;
  if (!json || !isObject(json.schema)) throw new Error(`GET ${route} documents no 200 application/json schema`);
  return json.schema;
}

/** Format issues for an assertion message. */
export function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map((i) => `${i.path || '/'}: ${i.message}`).join('\n');
}
