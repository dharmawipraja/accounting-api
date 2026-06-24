import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { statusFromException, PRISMA_STATUS } from './exception-status';
import { ConflictDomainError, ValidationFailedError } from './domain-errors';

describe('statusFromException', () => {
  it('maps a DomainError to its own .status', () => {
    expect(statusFromException(new ConflictDomainError('dup'))).toBe(409);
    expect(statusFromException(new ValidationFailedError('bad'))).toBe(422);
  });

  it('maps an HttpException to its getStatus()', () => {
    expect(statusFromException(new NotFoundException())).toBe(404);
    expect(statusFromException(new HttpException('teapot', 418))).toBe(418);
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
