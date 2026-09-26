import { BadRequestException } from '@nestjs/common';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import {
  GLOBAL_VALIDATION_OPTIONS,
  globalValidationPipe,
  isBodyValidated,
} from './validated-body';

class Dto {
  @IsString() @MaxLength(5) name!: string;
}

class EmailDto {
  @IsEmail() email!: string;
}

describe('AuditingValidationPipe (validated-body mark)', () => {
  const pipe = globalValidationPipe();

  it('a validator that THROWS (validator.js URIError on a lone surrogate) is a 400, not a 500 — and the body is not marked', async () => {
    const body = { email: 'a\ud800@x.io' };
    await expect(
      pipe.transform(body, { type: 'body', metatype: EmailDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(isBodyValidated(body)).toBe(false);
  });

  it('keeps the HttpException a validation failure already produced', async () => {
    const err: unknown = await pipe
      .transform({ email: 'nope' }, { type: 'body', metatype: EmailDto })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(
      (err as BadRequestException).getResponse() as { message: string[] },
    ).toMatchObject({ message: ['email must be an email'] });
  });

  it('marks the raw body object once a whole-body DTO passed validation', async () => {
    const body = { name: 'ok' };
    expect(isBodyValidated(body)).toBe(false);
    const out = await pipe.transform(body, { type: 'body', metatype: Dto });
    expect(out).toBeInstanceOf(Dto);
    expect(isBodyValidated(body)).toBe(true);
    expect(isBodyValidated(out)).toBe(false); // the mark is on req.body
  });

  it('never marks a rejected body (400) — the mark is set only after success', async () => {
    for (const body of [{ name: 'too-long' }, { name: 'ok', extra: 1 }]) {
      await expect(
        pipe.transform(body, { type: 'body', metatype: Dto }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(isBodyValidated(body)).toBe(false);
    }
  });

  it('never marks a body the pipe did not validate (no DTO / Object / property / non-body param)', async () => {
    const cases: Array<[object, Parameters<typeof pipe.transform>[1]]> = [
      [{ name: 'x' }, { type: 'body' }],
      [{ name: 'x' }, { type: 'body', metatype: Object }],
      [{ name: 'x' }, { type: 'body', metatype: Dto, data: 'name' }],
      [{ name: 'x' }, { type: 'query', metatype: Dto }],
      [{ name: 'x' }, { type: 'custom', metatype: Dto }],
    ];
    for (const [value, meta] of cases) {
      await pipe.transform(value, meta);
      expect(isBodyValidated(value)).toBe(false);
    }
  });

  it('isBodyValidated is false for non-objects', () => {
    for (const v of [undefined, null, 'x', 1]) {
      expect(isBodyValidated(v)).toBe(false);
    }
  });

  it('GLOBAL_VALIDATION_OPTIONS is frozen (shared by main.ts and every e2e bootstrap)', () => {
    expect(Object.isFrozen(GLOBAL_VALIDATION_OPTIONS)).toBe(true);
    expect(() => {
      (GLOBAL_VALIDATION_OPTIONS as { whitelist?: boolean }).whitelist = false;
    }).toThrow(TypeError);
    expect(GLOBAL_VALIDATION_OPTIONS).toEqual({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
  });
});
