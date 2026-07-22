import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const valid = {
  DATABASE_URL: 'postgres://app_api:x@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(32),
};

describe('loadConfig', () => {
  it('aceita o mínimo válido e aplica defaults', () => {
    const config = loadConfig(valid);
    expect(config.API_PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(config.RATE_LIMIT_MAX).toBe(120);
  });

  it('rejeita DATABASE_URL ausente nomeando a variável', () => {
    expect(() => loadConfig({ JWT_SECRET: valid.JWT_SECRET })).toThrowError(ConfigError);
    expect(() => loadConfig({ JWT_SECRET: valid.JWT_SECRET })).toThrowError(/DATABASE_URL/);
  });

  it('rejeita JWT_SECRET curto (piso de 32 chars)', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'curto' })).toThrowError(/JWT_SECRET/);
  });

  it('rejeita porta fora do range', () => {
    expect(() => loadConfig({ ...valid, API_PORT: '70000' })).toThrowError(/API_PORT/);
  });

  it('coage numéricos vindos de env string', () => {
    const config = loadConfig({ ...valid, API_PORT: '8080', RATE_LIMIT_MAX: '10' });
    expect(config.API_PORT).toBe(8080);
    expect(config.RATE_LIMIT_MAX).toBe(10);
  });

  it('lista TODOS os problemas de uma vez', () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/DATABASE_URL/);
      expect(String(error)).toMatch(/JWT_SECRET/);
    }
  });
});
