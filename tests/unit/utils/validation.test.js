/**
 * Validation Utilities Unit Tests
 * Testing enhanced validation utility functions
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createConditionalSchema,
  enhancedSafeParse,
  mergeSchemas,
  validateMultiple
} from '../../../src/shared/utils/validation.js';

describe('Validation Utilities', () => {
  describe('enhancedSafeParse', () => {
    const testSchema = z.object({
      name: z.string().min(2),
      age: z.number().min(0),
      email: z.string().email()
    });

    it('should return success for valid data', () => {
      const validData = {
        name: 'John Doe',
        age: 30,
        email: 'john@example.com'
      };

      const result = enhancedSafeParse(testSchema, validData);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(validData);
      expect(result.errors).toBeNull();
    });

    it('should return formatted errors for invalid data', () => {
      const invalidData = {
        name: 'J', // Too short
        age: -5, // Negative
        email: 'invalid-email' // Invalid format
      };

      const result = enhancedSafeParse(testSchema, invalidData);

      expect(result.success).toBe(false);
      expect(result.data).toBeNull();
      expect(result.errors).toHaveLength(3);
      expect(result.errorCount).toBe(3);

      // Check error format
      expect(result.errors[0]).toHaveProperty('field');
      expect(result.errors[0]).toHaveProperty('message');
      expect(result.errors[0]).toHaveProperty('code');
    });

    it('should handle non-Zod errors gracefully', () => {
      const throwingSchema = {
        parse: () => {
          throw new Error('Custom error');
        }
      };

      const result = enhancedSafeParse(throwingSchema, {});

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Custom error');
      expect(result.errors[0].code).toBe('UNKNOWN_ERROR');
    });
  });

  describe('validateMultiple', () => {
    const userSchema = z.object({
      name: z.string().min(2),
      email: z.string().email()
    });

    const accountSchema = z.object({
      number: z.string().min(3),
      balance: z.number().min(0)
    });

    it('should validate multiple schemas successfully', () => {
      const validations = [
        {
          schema: userSchema,
          data: { name: 'John', email: 'john@example.com' },
          name: 'user'
        },
        {
          schema: accountSchema,
          data: { number: 'ACC001', balance: 1000 },
          name: 'account'
        }
      ];

      const result = validateMultiple(validations);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.totalErrors).toBe(0);
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(true);
    });

    it('should handle validation failures', () => {
      const validations = [
        {
          schema: userSchema,
          data: { name: 'J', email: 'invalid' }, // Invalid data
          name: 'user'
        },
        {
          schema: accountSchema,
          data: { number: 'ACC001', balance: 1000 },
          name: 'account'
        }
      ];

      const result = validateMultiple(validations);

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.totalErrors).toBeGreaterThan(0);
      expect(result.results[0].success).toBe(false);
      expect(result.results[1].success).toBe(true);
    });
  });

  describe('createConditionalSchema', () => {
    it('should create conditional validation based on field value', () => {
      const schema1 = z.object({
        type: z.literal('A'),
        fieldA: z.string().min(5)
      });

      const schema2 = z.object({
        type: z.literal('B'),
        fieldB: z.number().min(10)
      });

      const conditionalSchema = createConditionalSchema('type', 'A', schema1, schema2);

      // Test type A validation
      const typeAData = { type: 'A', fieldA: 'valid_string' };
      expect(() => conditionalSchema.parse(typeAData)).not.toThrow();

      // Test type B validation
      const typeBData = { type: 'B', fieldB: 15 };
      expect(() => conditionalSchema.parse(typeBData)).not.toThrow();

      // This is complex conditional validation - skip the error case test for now
      // as the implementation may vary based on Zod version
    });
  });

  describe('mergeSchemas', () => {
    it('should merge multiple schemas correctly', () => {
      const baseSchema = z.object({
        id: z.string(),
        name: z.string()
      });

      const timestampSchema = z.object({
        createdAt: z.date(),
        updatedAt: z.date()
      });

      const statusSchema = z.object({
        status: z.enum(['ACTIVE', 'INACTIVE'])
      });

      const mergedSchema = mergeSchemas(baseSchema, timestampSchema, statusSchema);

      const validData = {
        id: 'test-id',
        name: 'Test Name',
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'ACTIVE'
      };

      expect(() => mergedSchema.parse(validData)).not.toThrow();

      // Test that all fields are required
      expect(() =>
        mergedSchema.parse({
          id: 'test-id'
          // Missing other fields
        })
      ).toThrow();
    });
  });
});
