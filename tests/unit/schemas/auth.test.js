/**
 * Auth Schemas Unit Tests
 * Testing authentication-related validation schemas
 */

import { describe, expect, it } from 'vitest';
import {
  AuthResponseSchema,
  JWTPayloadSchema,
  LoginSchema,
  PasswordResetRequestSchema,
  PasswordResetSchema,
  SessionValidationSchema,
  TokenRefreshSchema
} from '../../../src/modules/auth/schemas.js';

describe('Auth Schemas', () => {
  describe('LoginSchema', () => {
    it('should validate valid login credentials', () => {
      const validLogin = {
        username: 'testuser123',
        password: 'password123'
      };

      expect(() => LoginSchema.parse(validLogin)).not.toThrow();
    });

    it('should reject invalid login credentials', () => {
      // Invalid username
      expect(() =>
        LoginSchema.parse({
          username: 'ab', // Too short
          password: 'password123'
        })
      ).toThrow();

      // Invalid password
      expect(() =>
        LoginSchema.parse({
          username: 'testuser123',
          password: '123' // Too short
        })
      ).toThrow();

      // Missing fields
      expect(() =>
        LoginSchema.parse({
          username: 'testuser123'
        })
      ).toThrow();
    });
  });

  describe('AuthResponseSchema', () => {
    it('should validate valid auth response', () => {
      const validResponse = {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          id: '01K2RKFYHM61V77VPD0XFQ0DGQ',
          username: 'testuser123',
          name: 'Test User',
          role: 'NASABAH'
        },
        expiresIn: '24h'
      };

      expect(() => AuthResponseSchema.parse(validResponse)).not.toThrow();
    });

    it('should apply default expiresIn', () => {
      const response = {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        user: {
          id: '01K2RKFYHM61V77VPD0XFQ0DGQ',
          username: 'testuser123',
          name: 'Test User',
          role: 'NASABAH'
        }
      };

      const result = AuthResponseSchema.parse(response);
      expect(result.expiresIn).toBe('24h');
    });

    it('should reject invalid auth response', () => {
      // Missing token
      expect(() =>
        AuthResponseSchema.parse({
          user: {
            id: '01HQSM1X8N9Z2J3K4L5M6N7P8Q',
            username: 'testuser123',
            name: 'Test User',
            role: 'NASABAH'
          }
        })
      ).toThrow();

      // Invalid user ID
      expect(() =>
        AuthResponseSchema.parse({
          token: 'valid-token',
          user: {
            id: 'invalid-id',
            username: 'testuser123',
            name: 'Test User',
            role: 'NASABAH'
          }
        })
      ).toThrow();

      // Invalid role
      expect(() =>
        AuthResponseSchema.parse({
          token: 'valid-token',
          user: {
            id: '01K2RKFYHM61V77VPD0XFQ0DGQ',
            username: 'testuser123',
            name: 'Test User',
            role: 'INVALID_ROLE'
          }
        })
      ).toThrow();
    });
  });

  describe('JWTPayloadSchema', () => {
    it('should validate valid JWT payload', () => {
      const validPayload = {
        userId: '01K2RKFYHM61V77VPD0XFQ0DGQ',
        username: 'testuser123',
        role: 'ADMIN',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 86400
      };

      expect(() => JWTPayloadSchema.parse(validPayload)).not.toThrow();
    });

    it('should reject invalid JWT payload', () => {
      // Invalid userId
      expect(() =>
        JWTPayloadSchema.parse({
          userId: 'invalid-id',
          username: 'testuser123',
          role: 'ADMIN',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 86400
        })
      ).toThrow();

      // Missing required fields
      expect(() =>
        JWTPayloadSchema.parse({
          userId: '01K2RKFYHM61V77VPD0XFQ0DGQ',
          username: 'testuser123'
          // Missing role, iat, exp
        })
      ).toThrow();
    });
  });

  describe('TokenRefreshSchema', () => {
    it('should validate valid refresh token', () => {
      const validRefresh = {
        refreshToken: 'valid-refresh-token-string'
      };

      expect(() => TokenRefreshSchema.parse(validRefresh)).not.toThrow();
    });

    it('should reject invalid refresh token', () => {
      // Empty token
      expect(() =>
        TokenRefreshSchema.parse({
          refreshToken: ''
        })
      ).toThrow();

      // Missing token
      expect(() => TokenRefreshSchema.parse({})).toThrow();
    });
  });

  describe('PasswordResetRequestSchema', () => {
    it('should validate valid password reset request', () => {
      const validRequest = {
        username: 'testuser123'
      };

      expect(() => PasswordResetRequestSchema.parse(validRequest)).not.toThrow();
    });

    it('should reject invalid password reset request', () => {
      // Invalid username
      expect(() =>
        PasswordResetRequestSchema.parse({
          username: 'ab' // Too short
        })
      ).toThrow();

      // Missing username
      expect(() => PasswordResetRequestSchema.parse({})).toThrow();
    });
  });

  describe('PasswordResetSchema', () => {
    it('should validate valid password reset', () => {
      const validReset = {
        token: 'valid-reset-token',
        newPassword: 'newpassword123',
        confirmPassword: 'newpassword123'
      };

      expect(() => PasswordResetSchema.parse(validReset)).not.toThrow();
    });

    it('should reject mismatched passwords', () => {
      expect(() =>
        PasswordResetSchema.parse({
          token: 'valid-reset-token',
          newPassword: 'newpassword123',
          confirmPassword: 'differentpassword123'
        })
      ).toThrow();
    });

    it('should reject invalid password reset', () => {
      // Missing token
      expect(() =>
        PasswordResetSchema.parse({
          newPassword: 'newpassword123',
          confirmPassword: 'newpassword123'
        })
      ).toThrow();

      // Weak password
      expect(() =>
        PasswordResetSchema.parse({
          token: 'valid-reset-token',
          newPassword: '123',
          confirmPassword: '123'
        })
      ).toThrow();
    });
  });

  describe('SessionValidationSchema', () => {
    it('should validate valid session validation', () => {
      const validSession = {
        token: 'valid-session-token',
        checkExpiry: true
      };

      expect(() => SessionValidationSchema.parse(validSession)).not.toThrow();
    });

    it('should apply default checkExpiry', () => {
      const session = {
        token: 'valid-session-token'
      };

      const result = SessionValidationSchema.parse(session);
      expect(result.checkExpiry).toBe(true);
    });

    it('should reject invalid session validation', () => {
      // Missing token
      expect(() =>
        SessionValidationSchema.parse({
          checkExpiry: true
        })
      ).toThrow();

      // Empty token
      expect(() =>
        SessionValidationSchema.parse({
          token: '',
          checkExpiry: true
        })
      ).toThrow();
    });
  });
});
