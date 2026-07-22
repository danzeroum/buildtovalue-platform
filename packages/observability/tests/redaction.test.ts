import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/index.js';

/** Captura síncrona da saída do pino para inspecionar o JSON serializado. */
function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

/**
 * O teste-guardião da redaction (plano §8.1): se um campo sensível vazar no
 * log serializado, este teste FALHA. Ampliar REDACT_PATHS exige ampliar aqui.
 */
describe('redaction do logger', () => {
  it('redige credenciais em qualquer nível', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'test', destination: stream });
    logger.info(
      {
        password: 'hunter2',
        user: { passwordHash: 'abc', refreshToken: 'rt-1' },
        req: { headers: { authorization: 'Bearer xyz', cookie: 'sid=1' } },
        token: 'tok',
      },
      'login',
    );
    const output = lines.join('');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('Bearer xyz');
    expect(output).not.toContain('sid=1');
    expect(output).not.toContain('rt-1');
    expect(output).not.toContain('"tok"');
    expect(output).toContain('[REDACTED]');
  });

  it('redige o objeto variables inteiro (dados de negócio nunca em log)', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'test', destination: stream });
    logger.info({ instance: { variables: { cpf: '123.456.789-00' } } }, 'advance');
    logger.info({ variables: { salario: 12345 } }, 'submit');
    const output = lines.join('');
    expect(output).not.toContain('123.456.789-00');
    expect(output).not.toContain('12345');
  });

  it('mantém campos não sensíveis intactos', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'api', destination: stream });
    logger.info({ tenantId: 't-1', requestId: 'r-1' }, 'ok');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.tenantId).toBe('t-1');
    expect(parsed.service).toBe('api');
    expect(parsed.msg).toBe('ok');
  });
});
