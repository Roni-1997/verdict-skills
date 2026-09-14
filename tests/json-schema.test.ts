// tests/_json-schema.ts is the validator the API contract tests rely on, so each keyword it claims to implement is
// exercised both ways here, and the fail-closed rule (an unknown keyword throws) is pinned.
import { describe, expect, it } from 'vitest';
import { formatIssues, resolveRef, responseSchema, validateSchema } from './_json-schema.js';

const ok = (schema: unknown, value: unknown, root?: unknown) => expect(formatIssues(validateSchema(schema, value, root))).toBe('');
const bad = (schema: unknown, value: unknown, root?: unknown) => expect(validateSchema(schema, value, root).length).toBeGreaterThan(0);

describe('json schema subset validator', () => {
  it('type: single and list, integer versus number, null', () => {
    ok({ type: 'integer' }, 3);
    bad({ type: 'integer' }, 3.5);
    ok({ type: 'number' }, 3.5);
    bad({ type: 'number' }, Number.NaN);
    ok({ type: ['string', 'null'] }, null);
    ok({ type: ['string', 'null'] }, 'x');
    bad({ type: ['string', 'null'] }, 1);
    bad({ type: 'object' }, []);
    ok({ type: 'array' }, []);
    expect(() => validateSchema({ type: 'date' }, 'x')).toThrow(/unsupported JSON Schema type/);
  });
  it('enum and const compare by value', () => {
    ok({ enum: ['a', 'b'] }, 'b');
    bad({ enum: ['a', 'b'] }, 'c');
    ok({ const: 8 }, 8);
    bad({ const: 8 }, 9);
    ok({ const: { a: [1] } }, { a: [1] });
    bad({ const: { a: [1] } }, { a: [2] });
  });
  it('nullable admits null and nothing else extra', () => {
    ok({ type: 'string', nullable: true }, null);
    ok({ type: 'string', nullable: true }, 's');
    bad({ type: 'string', nullable: true }, 1);
    bad({ type: 'string' }, null);
  });
  it('anyOf needs one branch, oneOf exactly one, allOf every one', () => {
    const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };
    ok(nullableNumber, 1);
    ok(nullableNumber, null);
    bad(nullableNumber, 's');
    const exactlyOne = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
    ok(exactlyOne, 1.5);
    bad(exactlyOne, 1);
    bad(exactlyOne, 's');
    ok({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 2);
    bad({ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 1);
  });
  it('objects: properties, required, additionalProperties false or a schema, propertyNames', () => {
    const s = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    ok(s, { a: 'x' });
    bad(s, {});
    bad(s, { a: 'x', b: 1 });
    bad(s, { a: 1 });
    const record = { type: 'object', propertyNames: { type: 'string', pattern: '^[a-z]+$' }, additionalProperties: { type: 'string' } };
    ok(record, { abc: 'v' });
    bad(record, { abc: 1 });
    bad(record, { ABC: 'v' });
    ok({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', extra: 1 });
  });
  it('arrays: items, prefixItems with items false, minItems, maxItems', () => {
    ok({ type: 'array', items: { type: 'integer' } }, [1, 2]);
    bad({ type: 'array', items: { type: 'integer' } }, [1, 'x']);
    const pair = { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false, minItems: 2, maxItems: 2 };
    ok(pair, ['a', 1]);
    bad(pair, ['a']);
    bad(pair, ['a', 1, 2]);
    bad(pair, [1, 'a']);
    bad({ type: 'array', minItems: 1 }, []);
  });
  it('numeric and string bounds, pattern', () => {
    ok({ minimum: 0, maximum: 1 }, 0.5);
    bad({ minimum: 0 }, -1);
    bad({ maximum: 1 }, 2);
    ok({ exclusiveMinimum: 0 }, 0.1);
    bad({ exclusiveMinimum: 0 }, 0);
    bad({ exclusiveMaximum: 1 }, 1);
    ok({ minLength: 1, maxLength: 2 }, 'ab');
    bad({ minLength: 1 }, '');
    bad({ maxLength: 2 }, 'abc');
    ok({ pattern: '^[1-8]$' }, '3');
    bad({ pattern: '^[1-8]$' }, '9');
  });
  it('$ref resolves local pointers, applies sibling keywords, and fails loudly when missing', () => {
    const root = { components: { schemas: { Name: { type: 'string', minLength: 1 }, Wrapper: { type: 'object', properties: { n: { $ref: '#/components/schemas/Name' } }, required: ['n'] } } } };
    ok({ $ref: '#/components/schemas/Wrapper' }, { n: 'x' }, root);
    bad({ $ref: '#/components/schemas/Wrapper' }, { n: '' }, root);
    bad({ $ref: '#/components/schemas/Name', maxLength: 1 }, 'ab', root);
    expect(() => resolveRef('#/components/schemas/Missing', root)).toThrow(/does not resolve/);
    expect(() => resolveRef('https://example.com/schema.json', root)).toThrow(/only local/);
    expect(resolveRef('#/components/schemas/Name', root)).toEqual({ type: 'string', minLength: 1 });
  });
  it('an unknown validation keyword throws instead of passing silently; annotations and x- keys are ignored', () => {
    expect(() => validateSchema({ type: 'string', patternProperties: {} }, 'x')).toThrow(/unsupported JSON Schema keyword "patternProperties"/);
    expect(() => validateSchema({ type: 'string', not: {} }, 'x')).toThrow(/unsupported/);
    ok({ type: 'string', description: 'd', title: 't', example: 'e', 'x-custom': 1, format: 'date-time' }, 'x');
  });
  it('reports the path of each issue', () => {
    const s = { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] } } } };
    const issues = validateSchema(s, { a: [{ b: 1 }, { b: 'x' }, {}] });
    expect(issues.map((i) => i.path)).toEqual(['/a/1/b', '/a/2']);
    expect(formatIssues(issues)).toContain('/a/2: missing required property "b"');
  });
  it('responseSchema finds the 200 JSON body of a GET and names what is missing', () => {
    const doc = { paths: { '/x': { get: { responses: { '200': { content: { 'application/json': { schema: { type: 'string' } } } } } } }, '/y': { get: { responses: {} } } } };
    expect(responseSchema(doc, '/x')).toEqual({ type: 'string' });
    expect(() => responseSchema(doc, '/y')).toThrow(/documents no 200/);
    expect(() => responseSchema(doc, '/z')).toThrow(/no GET \/z/);
    expect(() => responseSchema({}, '/x')).toThrow(/no paths/);
  });
});
