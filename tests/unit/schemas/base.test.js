/**
 * Base Schemas Unit Tests
 * Testing fundamental validation schemas
 */

import { describe, expect, it } from 'vitest';
import {
  AccountCategorySchema,
  DateSchema,
  ErrorResponseSchema,
  IdParamSchema,
  NameSchema,
  NonNegativeDecimalSchema,
  PaginatedResponseSchema,
  PaginationSchema,
  PasswordSchema,
  PositiveDecimalSchema,
  RoleSchema,
  SuccessResponseSchema,
  UsernameSchema,
  UserStatusSchema,
  UUIDSchema
} from '../../../src/shared/schemas/base.js';

describe('Base Schemas', () => {
  describe('UUIDSchema', () => {
    it('should validate valid ULID', () => {
      const validULID = '01K2RKFYHM61V77VPD0XFQ0DGQ';
      expect(() => UUIDSchema.parse(validULID)).not.toThrow();
    });

    it('should reject invalid ULID', () => {
      expect(() => UUIDSchema.parse('invalid-id')).toThrow();
      expect(() => UUIDSchema.parse('')).toThrow();
      expect(() => UUIDSchema.parse('12345')).toThrow();
    });
  });

  describe('IdParamSchema', () => {
    it('should validate valid ID parameter', () => {
      const validParam = { id: '01K2RKFYHM61V77VPD0XFQ0DGQ' };
      expect(() => IdParamSchema.parse(validParam)).not.toThrow();
    });

    it('should reject invalid ID parameter', () => {
      expect(() => IdParamSchema.parse({ id: 'invalid' })).toThrow();
      expect(() => IdParamSchema.parse({})).toThrow();
    });
  });

  describe('PositiveDecimalSchema', () => {
    it('should validate positive decimal numbers', () => {
      expect(() => PositiveDecimalSchema.parse(100.5)).not.toThrow();
      expect(() => PositiveDecimalSchema.parse(0.01)).not.toThrow();
    });

    it('should reject zero and negative numbers', () => {
      expect(() => PositiveDecimalSchema.parse(0)).toThrow();
      expect(() => PositiveDecimalSchema.parse(-100)).toThrow();
    });

    it('should reject numbers with more than 2 decimal places', () => {
      expect(() => PositiveDecimalSchema.parse(100.123)).toThrow();
    });
  });

  describe('NonNegativeDecimalSchema', () => {
    it('should validate non-negative decimal numbers', () => {
      expect(() => NonNegativeDecimalSchema.parse(0)).not.toThrow();
      expect(() => NonNegativeDecimalSchema.parse(100.5)).not.toThrow();
    });

    it('should reject negative numbers', () => {
      expect(() => NonNegativeDecimalSchema.parse(-0.01)).toThrow();
    });
  });

  describe('DateSchema', () => {
    it('should validate date objects', () => {
      expect(() => DateSchema.parse(new Date())).not.toThrow();
    });

    it('should coerce valid date strings', () => {
      expect(() => DateSchema.parse('2025-01-15')).not.toThrow();
      expect(() => DateSchema.parse('2025-01-15T10:30:00Z')).not.toThrow();
    });

    it('should reject invalid date strings', () => {
      expect(() => DateSchema.parse('invalid-date')).toThrow();
      expect(() => DateSchema.parse('2025-13-45')).toThrow();
    });
  });

  describe('UsernameSchema', () => {
    it('should validate valid usernames', () => {
      expect(() => UsernameSchema.parse('user123')).not.toThrow();
      expect(() => UsernameSchema.parse('test_user-01')).not.toThrow();
    });

    it('should reject invalid usernames', () => {
      expect(() => UsernameSchema.parse('ab')).toThrow(); // Too short
      expect(() => UsernameSchema.parse('user@name')).toThrow(); // Invalid characters
      expect(() => UsernameSchema.parse(' username ')).toThrow(); // Should be trimmed and fail
    });
  });

  describe('PasswordSchema', () => {
    it('should validate valid passwords', () => {
      expect(() => PasswordSchema.parse('password123')).not.toThrow();
      expect(() => PasswordSchema.parse('123456')).not.toThrow();
    });

    it('should reject short passwords', () => {
      expect(() => PasswordSchema.parse('12345')).toThrow();
      expect(() => PasswordSchema.parse('')).toThrow();
    });
  });

  describe('NameSchema', () => {
    it('should validate valid names', () => {
      expect(() => NameSchema.parse('John Doe')).not.toThrow();
      expect(() => NameSchema.parse('Maria')).not.toThrow();
    });

    it('should reject invalid names', () => {
      expect(() => NameSchema.parse('A')).toThrow(); // Too short
      expect(() => NameSchema.parse('')).toThrow();
    });
  });

  describe('PaginationSchema', () => {
    it('should validate valid pagination parameters', () => {
      const validPagination = { limit: 10, skip: 0, page: 1 };
      expect(() => PaginationSchema.parse(validPagination)).not.toThrow();
    });

    it('should apply default values', () => {
      const result = PaginationSchema.parse({});
      expect(result.limit).toBe(20); // Default limit
      expect(result.skip).toBe(0);
      expect(result.page).toBe(1);
    });

    it('should reject invalid pagination parameters', () => {
      expect(() => PaginationSchema.parse({ limit: -1 })).toThrow();
      expect(() => PaginationSchema.parse({ limit: 1000 })).toThrow(); // Too large
      expect(() => PaginationSchema.parse({ skip: -1 })).toThrow();
      expect(() => PaginationSchema.parse({ page: 0 })).toThrow();
    });
  });

  describe('Response Schemas', () => {
    it('should validate success response', () => {
      const dataSchema = UUIDSchema;
      const validResponse = {
        success: true,
        data: '01K2RKFYHM61V77VPD0XFQ0DGQ',
        message: 'Success'
      };

      expect(() => SuccessResponseSchema(dataSchema).parse(validResponse)).not.toThrow();
    });

    it('should validate error response', () => {
      const validError = {
        success: false,
        error: 'Validation failed',
        statusCode: 400
      };

      expect(() => ErrorResponseSchema.parse(validError)).not.toThrow();
    });

    it('should validate paginated response', () => {
      const dataSchema = UUIDSchema;
      const validPaginated = {
        success: true,
        data: ['01K2RKFYHM61V77VPD0XFQ0DGQ'],
        pagination: {
          page: 1,
          limit: 10,
          total: 1,
          pages: 1
        }
      };

      expect(() => PaginatedResponseSchema(dataSchema).parse(validPaginated)).not.toThrow();
    });
  });

  describe('Enum Schemas', () => {
    it('should validate role enum', () => {
      expect(() => RoleSchema.parse('ADMIN')).not.toThrow();
      expect(() => RoleSchema.parse('NASABAH')).not.toThrow();
      expect(() => RoleSchema.parse('INVALID_ROLE')).toThrow();
    });

    it('should validate user status enum', () => {
      expect(() => UserStatusSchema.parse('ACTIVE')).not.toThrow();
      expect(() => UserStatusSchema.parse('INACTIVE')).not.toThrow();
      expect(() => UserStatusSchema.parse('INVALID_STATUS')).toThrow();
    });

    it('should validate account category enum', () => {
      expect(() => AccountCategorySchema.parse('ASSET')).not.toThrow();
      expect(() => AccountCategorySchema.parse('HUTANG')).not.toThrow();
      expect(() => AccountCategorySchema.parse('INVALID_CATEGORY')).toThrow();
    });
  });
});
