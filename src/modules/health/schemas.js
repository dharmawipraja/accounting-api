/**
 * Health Schemas
 * Validation schemas specific to health monitoring
 */

import { z } from 'zod';
import { HealthStatusSchema, ServiceHealthSchema } from '../../shared/schemas/common.js';

// Memory usage schema
export const MemoryUsageSchema = z.object({
  used: z.number(),
  total: z.number(),
  percentage: z.number().min(0).max(100)
});

// Database health schema
export const DatabaseHealthSchema = z.object({
  healthy: z.boolean(),
  version: z.string().optional(),
  connections: z.number().optional(),
  tableCount: z.number().optional(),
  responseTime: z.number().optional()
});

// Comprehensive health response schema
export const ComprehensiveHealthSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  uptime: z.number(),
  version: z.string(),
  memory: MemoryUsageSchema,
  database: DatabaseHealthSchema,
  services: z.array(ServiceHealthSchema).optional()
});

// Simple health check schema
export const SimpleHealthSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime()
});

// Readiness check schema
export const ReadinessSchema = z.object({
  ready: z.boolean(),
  services: z.object({
    database: z.boolean(),
    memory: z.boolean()
  })
});
