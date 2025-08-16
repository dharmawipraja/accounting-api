#!/usr/bin/env node
import { extendZodWithOpenApi, getRefId, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// This module exports a single function convertZodToJsonSchema which
// mirrors the previous runtime converter logic but is intended for
// build-time use only (documentation generation, CI checks, etc.).
export function convertZodToJsonSchema(zodSchema, opts = {}) {
  try {
    // Ensure the zod extension is applied for .openapi()
    extendZodWithOpenApi(z);

    // Try library helper if present
    // Some versions expose a convenience function - guard for it.
    // Note: import of library top-level helpers is avoided here for clarity.
    // Use the generator directly.
    const generator = new OpenApiGeneratorV3([zodSchema]);
    const components = generator.generateComponents();

    const refId = getRefId(zodSchema);
    if (refId && components && components.schemas && components.schemas[refId]) {
      return { $ref: `#/components/schemas/${refId}` };
    }

    if (components && components.schemas) {
      const keys = Object.keys(components.schemas);
      if (keys.length > 0) {
        if (opts?.title && keys.includes(opts.title)) {
          return components.schemas[opts.title];
        }
        return components.schemas[keys[0]];
      }
    }

    // Fallback - conservative conversion
    const seen = new WeakSet();
    const convert = zs => {
      if (!zs || typeof zs !== 'object') return { type: 'object' };
      if (seen.has(zs)) return { type: 'object' };
      seen.add(zs);

      const def = zs._def || {};
      const t = def.typeName || (zs.constructor && zs.constructor.name);

      if (t === 'ZodEffects' && def.schema) return convert(def.schema);
      if (t === 'ZodOptional' && def.innerType) return convert(def.innerType);
      if (t === 'ZodNullable' && def.innerType) {
        const core = convert(def.innerType);
        return { ...core, nullable: true };
      }
      if (t === 'ZodDefault' && def.innerType) return convert(def.innerType);

      if (t === 'ZodString') {
        const schema = { type: 'string' };
        if (def.checks) {
          for (const c of def.checks) {
            if (c.kind === 'min') schema.minLength = c.value;
            if (c.kind === 'max') schema.maxLength = c.value;
            if (c.kind === 'email') schema.format = 'email';
            if (c.kind === 'url') schema.format = 'uri';
            if (c.kind === 'uuid') schema.format = 'uuid';
          }
        }
        return schema;
      }
      if (t === 'ZodNumber') {
        const schema = { type: 'number' };
        if (def.checks) {
          for (const c of def.checks) {
            if (c.kind === 'min') schema.minimum = c.value;
            if (c.kind === 'max') schema.maximum = c.value;
            if (c.kind === 'int') schema.type = 'integer';
          }
        }
        return schema;
      }
      if (t === 'ZodBoolean') return { type: 'boolean' };
      if (t === 'ZodLiteral') return { const: def.value, type: typeof def.value };
      if (t === 'ZodEnum' || t === 'ZodNativeEnum') {
        let values = [];
        // eslint-disable-next-line prefer-destructuring
        if (Array.isArray(def.values) && def.values.length > 0) values = def.values;
        else if (Array.isArray(def.options) && def.options.length > 0) values = def.options;
        const { nativeEnum } = def;
        if (nativeEnum && typeof nativeEnum === 'object') {
          values = Object.values(nativeEnum).filter(
            v => typeof v === 'string' || typeof v === 'number'
          );
        }

        if (Array.isArray(values) && values.length > 0) {
          return { type: typeof values[0] === 'number' ? 'number' : 'string', enum: values };
        }

        return { type: 'string' };
      }
      if (t === 'ZodArray') {
        const items = def.type ? convert(def.type) : { type: 'object' };
        return { type: 'array', items };
      }
      if (t === 'ZodObject') {
        const shape = typeof def.shape === 'function' ? def.shape() : def.shape || {};
        const properties = {};
        const required = [];
        for (const [k, v] of Object.entries(shape)) {
          properties[k] = convert(v);
          const vdef = v && v._def;
          const isOptional =
            vdef && (vdef.typeName === 'ZodOptional' || vdef.typeName === 'ZodDefault');
          if (!isOptional) required.push(k);
        }
        const obj = { type: 'object', properties };
        if (required.length > 0) obj.required = required;
        obj.additionalProperties = false;
        return obj;
      }
      if (t === 'ZodUnion') {
        const options = (def.options || []).map(convert);
        return { anyOf: options };
      }

      return { type: 'object', additionalProperties: true };
    };

    return convert(zodSchema);
  } catch (err) {
    console.error('Error generating JSON schema from Zod schema:', err);
    return { type: 'object' };
  }
}
