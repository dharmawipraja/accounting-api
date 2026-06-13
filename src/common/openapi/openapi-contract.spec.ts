// src/common/openapi/openapi-contract.spec.ts
import { readFileSync } from 'fs';
import { join } from 'path';

interface OpenApiDoc {
  paths: Record<
    string,
    Record<
      string,
      {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: unknown }> }
        >;
      }
    >
  >;
}

// Endpoints whose 2xx body is legitimately not application/json.
const TEXT_PLAIN_PATHS = new Set(['/metrics']);

describe('OpenAPI response contract', () => {
  const doc = JSON.parse(
    readFileSync(join(process.cwd(), 'docs/api/openapi.json'), 'utf8'),
  ) as OpenApiDoc;

  it('every 2xx response declares a non-empty body schema', () => {
    const offenders: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        for (const [code, res] of Object.entries(op.responses ?? {})) {
          if (!code.startsWith('2')) continue;
          if (code === '204') continue; // no body by design
          const label = `${method.toUpperCase()} ${path} (${code})`;
          if (TEXT_PLAIN_PATHS.has(path)) {
            if (!res.content?.['text/plain']?.schema) offenders.push(label);
            continue;
          }
          const schema = res.content?.['application/json']?.schema as
            | Record<string, unknown>
            | undefined;
          const isBare =
            schema &&
            Object.keys(schema).length === 1 &&
            schema.type === 'object';
          if (!schema || isBare) offenders.push(label);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
