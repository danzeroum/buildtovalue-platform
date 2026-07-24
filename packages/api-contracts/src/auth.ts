import { z } from 'zod';

export const loginRequestSchema = z.object({
  tenant: z.string().min(2).max(63).describe('Slug do tenant (ex.: "acme")'),
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int(),
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    email: z.string(),
    role: z.enum(['admin', 'analyst', 'business', 'operator', 'auditor']),
  }),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'analyst', 'business', 'operator', 'auditor']),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
