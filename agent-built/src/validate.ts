// Input validation: a request that does not match its schema is answered 400 before any handler
// code runs, so handlers only ever see well-formed, bounded input.
import type { Context } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { fail } from './errors.ts';

function explain(error: z.ZodError) {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return `${where}${issue?.message ?? 'invalid input'}`;
}

const check = <T extends z.ZodType>(schema: T) => (value: unknown, c: Context) => {
  const result = schema.safeParse(value);
  if (!result.success) return fail(c, 400, 'invalid_request', explain(result.error));
  return result.data as z.output<T>;
};

/** A JSON body. Hono refuses a body that is not application/json or not valid JSON. */
export const body = <T extends z.ZodType>(schema: T) => validator('json', check(schema));
/** Query string parameters. */
export const query = <T extends z.ZodType>(schema: T) => validator('query', check(schema));
/** Path parameters. */
export const params = <T extends z.ZodType>(schema: T) => validator('param', check(schema));

/** An MDRN record id: letters, digits, _ and -, at most 128 characters. */
export const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'not a valid id');
/** A short code: 3 to 32 lowercase letters, digits and dashes. */
export const code = z.string().regex(/^[a-z0-9-]{3,32}$/, 'use 3 to 32 lowercase letters, digits or dashes');
