/**
 * Request validation.
 *
 * Every route declares a zod schema for the part of the request it reads
 * (body / query / params). `validate()` replaces the raw value with the parsed
 * one, so downstream handlers get coerced, trimmed, typed data
 * (`"5"` -> number 5, `"  a@b.com  "` -> "a@b.com") for free.
 */
import { AppError } from './error.js';

/** Flattens zod issues into { "email": "Invalid email" } for form errors. */
function formatIssues(issues) {
  const fieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.join('.') || '_';
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }
  return fieldErrors;
}

/**
 * @param {{ body?: import('zod').ZodTypeAny,
 *           query?: import('zod').ZodTypeAny,
 *           params?: import('zod').ZodTypeAny }} schemas
 *   A plain object of per-source schemas. Passing a single `z.object({ body })`
 *   looks right but silently skips validation, because a ZodObject does not
 *   expose its shape as properties - hence the guard below.
 */
export const validate = (schemas) => {
  const middleware = (req, res, next) => {
    try {
      if (typeof schemas?.safeParse === 'function') {
        throw new Error(
          'validate() expects { body?, query?, params? } with one zod schema per source, not a single z.object({...}). See auth.schemas.js.',
        );
      }

      for (const source of ['params', 'query', 'body']) {
        if (!schemas[source]) continue;
        const result = schemas[source].safeParse(req[source]);
        if (!result.success) {
          throw AppError.unprocessable(
            `Invalid request ${source}`,
            formatIssues(result.error.issues),
          );
        }
        // Express 5 makes req.query a getter; assigning to a per-request object
        // keeps this working on both Express 4 and 5.
        if (source === 'query') {
          Object.defineProperty(req, 'validatedQuery', { value: result.data, writable: true });
        } else {
          req[source] = result.data;
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  // Tagged so tooling can audit which routes validate their input without a
  // database (see scripts/routes.js).
  middleware.validatesRequest = true;
  return middleware;
};

/** Reads validated query params (falls back to the raw object). */
export const queryOf = (req) => req.validatedQuery ?? req.query;
