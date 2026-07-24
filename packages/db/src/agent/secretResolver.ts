import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';

/**
 * Resolvedor de `secret://` (§A do Gate 8.4). A plataforma guarda no banco SÓ o
 * PONTEIRO (`tenant_ai_config.key_ref = secret://…`, CHECK na 0006) — nunca a
 * chave. Quem precisa da chave (o AIProvider real) resolve o ponteiro no
 * RUNTIME por este seam. A interface é estável: trocar o backend local por
 * Vault/KMS depois não toca em nenhum chamador.
 *
 * Backends locais (ambiente de teste/demo na VPS):
 *  - `env`  — variável `SECRET_<PATH>` (path canonizado). Sem arquivo em disco.
 *  - `file` — arquivo `<baseDir>/<path>` com PERMISSÃO RESTRITA. FAIL-CLOSED:
 *             arquivo legível por grupo/outros é RECUSADO (o segredo não pode
 *             vazar por permissão frouxa — mesma acidez do resto da plataforma).
 */
export interface SecretResolver {
  /** Resolve `secret://<path>` no valor do segredo. Lança se ausente/inseguro. */
  resolve(ref: string): Promise<string>;
}

export type SecretBackend = 'env' | 'file';

const PREFIX = 'secret://';

/** `secret://tenants/acme/ai-key` → `TENANTS_ACME_AI_KEY` (nome de env estável). */
export function secretEnvName(path: string): string {
  return 'SECRET_' + path.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function pathOf(ref: string): string {
  if (!ref.startsWith(PREFIX)) {
    throw new Error(`ref de segredo inválida (esperado secret://…): ${ref}`);
  }
  const path = ref.slice(PREFIX.length);
  // sem travessia de diretório nem caminho absoluto (fail-closed).
  if (path.length === 0 || path.includes('..') || isAbsolute(path) || normalize(path) !== path) {
    throw new Error(`caminho de segredo inseguro: ${ref}`);
  }
  return path;
}

export function createLocalSecretResolver(opts: {
  backend: SecretBackend;
  /** obrigatório para `file`: raiz dos segredos (fora do repo, perms restritas). */
  baseDir?: string;
  /** injeção para teste; default `process.env`. */
  env?: NodeJS.ProcessEnv;
}): SecretResolver {
  const env = opts.env ?? process.env;
  return {
    async resolve(ref) {
      const path = pathOf(ref);
      if (opts.backend === 'env') {
        const name = secretEnvName(path);
        const value = env[name];
        if (value === undefined || value === '') {
          throw new Error(`segredo ausente: ${ref} (defina a env ${name})`);
        }
        return value;
      }
      // backend = file
      if (!opts.baseDir) throw new Error('backend "file" exige baseDir');
      const file = join(opts.baseDir, path);
      let mode: number;
      try {
        mode = statSync(file).mode;
      } catch {
        throw new Error(`segredo ausente: ${ref} (arquivo ${file} não encontrado)`);
      }
      // FAIL-CLOSED: recusa se grupo/outros têm QUALQUER bit (0o077).
      if ((mode & 0o077) !== 0) {
        throw new Error(
          `segredo com permissão frouxa: ${file} (0${(mode & 0o777).toString(8)}) — exija chmod 600`,
        );
      }
      const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
      if (value.length === 0) throw new Error(`segredo vazio: ${ref}`);
      return value;
    },
  };
}
