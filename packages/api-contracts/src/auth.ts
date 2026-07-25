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
  // AG-3.5 (A6-A): o console abre a tela obrigatória de troca sem round-trip extra.
  mustChangePassword: z.boolean(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const dateFormatSchema = z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']);

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  displayName: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'analyst', 'business', 'operator', 'auditor']),
  // AG-3.5 (A5/A6-A).
  mustChangePassword: z.boolean(),
  timezone: z.string(),
  dateFormat: dateFormatSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;
