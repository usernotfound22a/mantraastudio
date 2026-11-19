/**
 * Error plumbing.
 *
 * Rule of thumb: route handlers throw, ONE middleware turns errors into JSON.
 * Nothing else in the app writes `res.status(500).json(...)` by hand, so the
 * error format is always identical for the frontend:
 *   { error: { code, message, details? } }
 */

/** An error we deliberately raised: safe to show the client. */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, details) {
    return new AppError(message, 400, 'BAD_REQUEST', details);
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError(message, 401, 'UNAUTHORIZED');
  }

  static forbidden(message = 'You do not have permission to do that') {
    return new AppError(message, 403, 'FORBIDDEN');
  }

  static notFound(message = 'Resource not found') {
    return new AppError(message, 404, 'NOT_FOUND');
  }

  static conflict(message, details) {
    return new AppError(message, 409, 'CONFLICT', details);
  }

  static unprocessable(message, details) {
    return new AppError(message, 422, 'UNPROCESSABLE', details);
  }

  static tooManyRequests(message = 'Too many requests, slow down a little') {
    return new AppError(message, 429, 'TOO_MANY_REQUESTS');
  }

  static paymentRequired(message) {
    return new AppError(message, 402, 'PAYMENT_REQUIRED');
  }

  static serviceUnavailable(message) {
    return new AppError(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

/**
 * Wraps an async route handler so rejected promises reach the error middleware
 * (Express 4 does not await handlers; without this an async throw hangs the
 * request forever).
 */
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/** 404 handler for unmatched routes. Mounted after all routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} does not exist`,
    },
  });
}

/** Maps Supabase/PostgREST, Auth, zod, and multer errors onto friendly AppErrors. */
function normalise(error) {
  if (error?.isOperational) return error;

  // multer signals upload problems with a `code`, not a status. Turn them into
  // real 4xx responses instead of letting them surface as 500s.
  if (error?.name === 'MulterError') {
    const message = {
      LIMIT_FILE_SIZE: `That file is too large (max ${Math.round((error.limit ?? 0) / 1024 / 1024)} MB)`,
      LIMIT_FILE_COUNT: 'Too many files in one upload',
      LIMIT_UNEXPECTED_FILE: `Unexpected field "${error.field}" - use "files"`,
    }[error.code];
    return new AppError(message ?? 'That upload could not be processed', 400, 'UPLOAD_FAILED');
  }

  switch (error?.code) {
    case '23505':
      return new AppError('That value is already taken', 409, 'DUPLICATE', {
        field: error.constraint,
      });
    case '23503':
      return new AppError('Related record does not exist', 400, 'INVALID_REFERENCE');
    case '40P01':
    case '55P03':
      return new AppError('The database is busy, please retry', 409, 'DB_CONFLICT');
    case 'ECONNREFUSED':
    case '08000':
    case '08003':
    case '08006':
      return new AppError('Database is unavailable', 503, 'DB_UNAVAILABLE');
    case 'ERR_JWT_EXPIRED':
      return new AppError('Session expired, please sign in again', 401, 'TOKEN_EXPIRED');
    case 'ERR_JWT_INVALID':
      return new AppError('Invalid token', 401, 'TOKEN_INVALID');
    case 'ERR_INVALID_ARG_TYPE':
    case 'ERR_INVALID_ARG_VALUE':
      return new AppError('Invalid request', 400, 'BAD_REQUEST');
    default:
      return null;
  }
}

/** Central Express error middleware. Must be registered LAST. */
// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
export function errorHandler(error, req, res, next) {
  const appError = normalise(error) || error;

  // Zod errors are produced by the validate() middleware; never expected here.
  if (appError instanceof Error && appError.name === 'ZodError') {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request body failed validation',
        details: appError.issues,
      },
    });
  }

  const statusCode = appError.statusCode || 500;
  const isServerError = statusCode >= 500;

  // Log unexpected errors with full stack, expected ones as a single line.
  if (isServerError) {
    req.log?.error({ err: appError, path: req.originalUrl }, 'Unhandled server error');
  } else {
    req.log?.warn({ code: appError.code, path: req.originalUrl }, appError.message);
  }

  res.status(statusCode).json({
    error: {
      code: appError.code || 'INTERNAL_ERROR',
      // Never leak internal messages/SQL in production.
      message: isServerError && !appError.isOperational ? 'Something went wrong' : appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      ...(process.env.NODE_ENV !== 'production' && isServerError
        ? { stack: appError.stack }
        : {}),
    },
  });
}
