jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
import * as Sentry from '@sentry/node';
import { BadRequestException } from '@nestjs/common';
import {
  IsEmail,
  IsString,
  MaxLength,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import {
  GLOBAL_VALIDATION_OPTIONS,
  globalValidationPipe,
} from './global-validation-pipe';

class Dto {
  @IsString() @MaxLength(5) name!: string;
}

class EmailDto {
  @IsEmail() email!: string;
}

/** A custom validator that throws a non-URIError — a validator DEFECT. */
function ThrowsTypeError(opts?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'throwsTypeError',
      validator: {
        validate: () => {
          throw new TypeError('boom');
        },
      },
    },
    opts,
  );
}

class DefectDto {
  @ThrowsTypeError() value!: string;
}

describe('BackstopValidationPipe', () => {
  const pipe = globalValidationPipe();

  it('a validator that THROWS (validator.js URIError on a lone surrogate) is a 400, not a 500', async () => {
    const body = { email: 'a\ud800@x.io' };
    await expect(
      pipe.transform(body, { type: 'body', metatype: EmailDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a URIError from a validator is a 400 with NO Sentry event (client input)', async () => {
    const capture = Sentry.captureException as jest.Mock;
    capture.mockClear();
    await expect(
      pipe.transform(
        { email: 'a\ud800@x.io' },
        { type: 'body', metatype: EmailDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(capture).not.toHaveBeenCalled();
  });

  it('any OTHER validator throw stays a 400 but is reported to Sentry at warning level (tag validator-backstop)', async () => {
    const capture = Sentry.captureException as jest.Mock;
    capture.mockClear();
    await expect(
      pipe.transform({ value: 'x' }, { type: 'body', metatype: DefectDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(capture).toHaveBeenCalledTimes(1);
    const [err, ctx] = capture.mock.calls[0] as [
      unknown,
      { level: string; tags: Record<string, string> },
    ];
    expect(err).toBeInstanceOf(TypeError);
    expect(ctx.level).toBe('warning');
    expect(ctx.tags).toMatchObject({ kind: 'validator-backstop' });
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

  it('returns the transformed DTO on success', async () => {
    const out = await pipe.transform(
      { name: 'ok' },
      { type: 'body', metatype: Dto },
    );
    expect(out).toBeInstanceOf(Dto);
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
