// src/common/openapi/openapi-contract.spec.ts
import { readFileSync } from 'fs';
import { join } from 'path';

interface OpenApiDoc {
  components: {
    schemas: Record<
      string,
      { properties: Record<string, { pattern?: string }> }
    >;
  };
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: { name: string; schema?: { enum?: string[] } }[];
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
/** File downloads documented with their own media type. */
const XML_PATHS = new Set(['/v1/tax/coretax/faktur-keluaran']);

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
          if (XML_PATHS.has(path)) {
            if (!res.content?.['application/xml']?.schema)
              offenders.push(label);
            continue;
          }
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

  it('partner code / name advertise the non-blank pattern the DTO enforces', () => {
    const { schemas } = doc.components;
    expect(schemas.CreateBusinessPartnerDto.properties.code.pattern).toBe(
      '\\S',
    );
    expect(schemas.CreateBusinessPartnerDto.properties.name.pattern).toBe(
      '\\S',
    );
    expect(schemas.UpdateBusinessPartnerDto.properties.name.pattern).toBe(
      '\\S',
    );
  });

  it('GET /v1/audit ?method= accepts the CLI rows written by create-admin and the MIGRATION rows of data migrations', () => {
    const method = doc.paths['/v1/audit'].get.parameters?.find(
      (p) => p.name === 'method',
    );
    expect(method?.schema?.enum).toEqual([
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
      'CLI',
      'MIGRATION',
    ]);
  });
});
