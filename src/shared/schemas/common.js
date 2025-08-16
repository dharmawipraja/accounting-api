/**
 * Common Validation Schemas
 * Additional validation schemas for common operations
 */

import { z } from 'zod';
import { DateSchema, NonEmptyStringSchema, UUIDSchema } from './base.js';

// =================
// Database Operations
// =================

export const SoftDeleteSchema = z.object({
  deletedAt: DateSchema.nullable().optional(),
  deletedBy: UUIDSchema.optional()
});

export const AuditableSchema = z.object({
  createdAt: DateSchema,
  updatedAt: DateSchema,
  createdBy: UUIDSchema,
  updatedBy: UUIDSchema
});

// =================
// Bulk Operations
// =================

export const BulkOperationSchema = z.object({
  operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
  items: z.array(z.record(z.any())).min(1).max(100) // Max 100 items per bulk operation
});

export const BulkResultSchema = z.object({
  successful: z.number(),
  failed: z.number(),
  total: z.number(),
  errors: z
    .array(
      z.object({
        index: z.number(),
        error: z.string(),
        item: z.record(z.any()).optional()
      })
    )
    .optional()
});

// =================
// API Response Metadata
// =================

export const MetadataSchema = z.object({
  timestamp: z.string().datetime(),
  version: z.string().optional(),
  requestId: z.string().optional(),
  processingTime: z.number().optional()
});

export const EnhancedSuccessResponseSchema = dataSchema =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
    message: z.string().optional(),
    metadata: MetadataSchema.optional()
  });

// =================
// Filter and Sort Schemas
// =================

export const SortDirectionSchema = z.enum(['asc', 'desc']);

export const SortSchema = z.object({
  field: NonEmptyStringSchema,
  direction: SortDirectionSchema.default('asc')
});

export const FilterOperatorSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith'
]);

export const FilterSchema = z.object({
  field: NonEmptyStringSchema,
  operator: FilterOperatorSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()])
});

export const QueryFiltersSchema = z.object({
  filters: z.array(FilterSchema).optional(),
  sort: z.array(SortSchema).optional(),
  search: z.string().optional()
});

// =================
// File Upload Schemas
// =================

export const FileUploadSchema = z.object({
  filename: NonEmptyStringSchema,
  mimetype: z.string().regex(/^[a-z]+\/[a-z0-9\-\+\.]+$/i, 'Invalid MIME type'),
  size: z
    .number()
    .positive()
    .max(10 * 1024 * 1024), // Max 10MB
  encoding: z.string().optional()
});

// =================
// Health Check Schemas
// =================

export const HealthStatusSchema = z.enum(['healthy', 'degraded', 'unhealthy']);

export const ServiceHealthSchema = z.object({
  name: NonEmptyStringSchema,
  status: HealthStatusSchema,
  responseTime: z.number().optional(),
  error: z.string().optional()
});

export const HealthCheckResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  uptime: z.number(),
  services: z.array(ServiceHealthSchema)
});
