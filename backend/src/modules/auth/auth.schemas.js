/**
 * Zod schemas for the auth endpoints. Messages are written for end users so
 * the React forms can show them directly.
 *
 * IMPORTANT: these are PLAIN objects of per-source schemas, because that is what
 * `validate()` expects: `{ body: ZodType, query: ZodType, params: ZodType }`.
 * Do not wrap them in `z.object({ ... })` - a ZodObject does not expose its
 * shape as properties, so `schema.body` would be undefined and every check
 * would be skipped. `validate()` throws if you get this wrong.
 */
import { z } from 'zod';

const email = z
  .string({ required_error: 'Email is required' })
  .trim()
  .toLowerCase()
  .min(5, 'Email is required')
  .max(191, 'Email is too long')
  .email('Enter a valid email address');

const password = z
  .string({ required_error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be 72 characters or fewer') // bcrypt's hard limit
  .regex(/[a-z]/, 'Include at least one lowercase letter')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/[0-9]/, 'Include at least one number');

const fullName = z
  .string({ required_error: 'Your name is required' })
  .trim()
  .min(2, 'Enter your full name')
  .max(120, 'Name is too long');

export const registerSchema = {
  body: z.object({
    email,
    password,
    fullName,
    workspaceName: z
      .string({ required_error: 'Workspace name is required' })
      .trim()
      .min(2, 'Enter a workspace name')
      .max(150, 'Workspace name is too long'),
  }),
};

export const loginSchema = {
  body: z.object({
    email,
    // Deliberately lenient: an old account may predate the strong-password rule.
    password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
    rememberMe: z.boolean().optional().default(false),
  }),
};

export const refreshSchema = {
  body: z.object({
    refreshToken: z.string().min(20, 'refreshToken is required'),
  }),
};

export const changePasswordSchema = {
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
  }),
};

export const updateProfileSchema = {
  body: z
    .object({
      fullName: fullName.optional(),
      avatarUrl: z.string().url('Enter a valid URL').max(500).nullish(),
      jobTitle: z.string().trim().max(120).nullish(),
      phone: z.string().trim().max(40).nullish(),
    })
    // Allow a partial update without sending every field.
    .partial(),
};
