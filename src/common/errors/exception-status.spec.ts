import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { statusFromException, PRISMA_STATUS } from './exception-status';
import {
  ConflictDomainError,
  ValidationFailedError,
  PasswordChangeRequiredError,
} from './domain-errors';

describe('statusFromException', () => {
  it('maps a DomainError to its own .status', () => {
    expect(statusFromException(new ConflictDomainError('dup'))).toBe(409);
    expect(statusFromException(new ValidationFailedError('bad'))).toBe(422);
  });

  it('maps PasswordChangeRequiredError to 403', () => {
    expect(
      statusFromException(new PasswordChangeRequiredError('change it')),
    ).toBe(403);
  });

  it('maps an HttpException to its getStatus()', () => {
    expect(statusFromException(new NotFoundException())).toBe(404);
    expect(statusFromException(new HttpException('teapot', 418))).toBe(418);
  });

  it('maps P2020 (value out of range, e.g. numeric overflow) to 400', () => {
    // A >16-integer-digit money value that slips past DTO validation must
    // degrade to a client error, not a 500 + Sentry incident.
    expect(PRISMA_STATUS.P2020).toEqual({
      status: 400,
      code: 'INVALID_INPUT',
      message: 'Value out of range',
    });
  });

  it('maps each known Prisma code per PRISMA_STATUS', () => {
    for (const [code, { status }] of Object.entries(PRISMA_STATUS)) {
      const err = new Prisma.PrismaClientKnownRequestError('m', {
        code,
        clientVersion: Prisma.prismaVersion.client,
      });
      expect(statusFromException(err)).toBe(status);
    }
  });

  it('maps an unmapped Prisma known code to 500', () => {
    const err = new Prisma.PrismaClientKnownRequestError('m', {
      code: 'P2037',
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(statusFromException(err)).toBe(500);
  });

  it('maps a PrismaClientValidationError to 400', () => {
    const err = new Prisma.PrismaClientValidationError('m', {
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(statusFromException(err)).toBe(400);
  });

  it('maps anything else to 500', () => {
    expect(statusFromException(new Error('boom'))).toBe(500);
    expect(statusFromException('nope')).toBe(500);
    expect(statusFromException(undefined)).toBe(500);
  });
});
