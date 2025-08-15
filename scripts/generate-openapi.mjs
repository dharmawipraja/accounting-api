#!/usr/bin/env node
import { extendZodWithOpenApi, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import * as schemasModule from '../src/schemas/index.js';
import { convertZodToJsonSchema } from './zod-to-jsonschema.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async function generate() {
  try {
    // Ensure zod openapi extension is applied (provide the zod instance)
    extendZodWithOpenApi(z);

    // Collect exported Zod schemas from src/schemas/index.js
    // Collect exported Zod schema objects. Skip helpers and functions that
    // require runtime inputs (e.g. SuccessResponseSchema(inner)).
    const exported = Object.entries(schemasModule)
      .map(([k, v]) => ({ k, v }))
      .filter(({ v }) => v && typeof v === 'object' && v._def)
      .map(({ v }) => v);

    // If no schemas exported, try to include the module directly
    if (exported.length === 0) {
      console.warn('No Zod schemas detected in src/schemas/index.js exports');
    }

    // Create generator and produce an OpenAPI document. Use generateDocument
    // which returns the full OpenAPI document.
    const generator = new OpenApiGeneratorV3(exported);
    const doc = generator.generateDocument({
      openapi: '3.0.0',
      info: { title: 'Accounting API', version: process.env.npm_package_version || '1.0.0' }
    });

    // Ensure docs directory exists
    const outDir = path.join(__dirname, '..', 'docs');
    await fs.mkdir(outDir, { recursive: true });

    const outFile = path.join(outDir, 'openapi.json');
    // Merge per-schema JSON Schema conversions for any exported Zod schemas
    // that the generator may not have materialized as component schemas.
    doc.components = doc.components || {};
    doc.components.schemas = doc.components.schemas || {};

    for (const [key, value] of Object.entries(schemasModule)) {
      try {
        // Only attempt conversion for Zod schema objects
        if (!value || typeof value !== 'object' || !value._def) continue;
        // If generator already produced a schema with this ref/name, skip
        if (doc.components.schemas[key]) continue;
        const converted = convertZodToJsonSchema(value, { title: key });
        if (converted && typeof converted === 'object') {
          // If convert returned a $ref, try to resolve to a concrete schema
          if (converted.$ref) {
            // skip refs - the generator should already produce the referenced component
            continue;
          }
          doc.components.schemas[key] = converted;
        }
      } catch (e) {
        console.warn('Per-schema conversion failed for', key, e?.message || e);
      }
    }

    await fs.writeFile(outFile, JSON.stringify(doc, null, 2), 'utf8');

    console.log('OpenAPI document written to', outFile);
  } catch (err) {
    console.error('Failed to generate OpenAPI document:', err);
    process.exit(1);
  }
})();
