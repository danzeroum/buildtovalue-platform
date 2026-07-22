import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * KeyProvider (D20): a PLATAFORMA nunca conhece "a chave" — conhece um
 * provedor. Dev/CI usam o provedor de ambiente abaixo; produção usa KMS por
 * tenant (F5). CHAVE ESTÁTICA EM PRODUÇÃO REPROVA O GATE DE PILOTO (8.4) —
 * o provedor de ambiente existe para desenvolvimento e teste, e diz isso.
 */
export interface KeyProvider {
  /** Chave ATIVA para cifrar (id versionado + material de 32 bytes). */
  active(): Promise<{ keyId: string; key: Buffer }>;
  /** Material para decifrar registros gravados com uma chave anterior. */
  byId(keyId: string): Promise<Buffer | undefined>;
}

/** Provedor de DEV/CI: deriva a chave de um segredo de ambiente (scrypt). */
export function createEnvKeyProvider(secret: string, keyId = 'env-v1'): KeyProvider {
  if (secret.length < 16) {
    throw new Error('KeyProvider de ambiente exige segredo com >= 16 caracteres');
  }
  const key = scryptSync(secret, `btv-field:${keyId}`, 32);
  return {
    async active() {
      return { keyId, key };
    },
    async byId(id) {
      return id === keyId ? key : undefined;
    },
  };
}

/** Prefixo dos valores cifrados em repouso: enc:v1:<keyId>:<iv>:<tag>:<dados>. */
const ENC_PREFIX = 'enc:v1:';

export function isEncryptedField(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export interface FieldCipher {
  /** Cifra um valor JSON-serializável (AES-256-GCM, IV por registro). */
  encrypt(value: unknown): Promise<string>;
  /** Decifra um valor gravado por encrypt (qualquer chave conhecida). */
  decrypt(encoded: string): Promise<unknown>;
}

/**
 * Middleware de criptografia de campos `sensitive` (plano §F2 item 6):
 * o conteúdo vive nas tabelas MUTÁVEIS cifrado; o ledger só vê hashes e
 * referências (ADR-0002). Limitação REGISTRADA (D20): campo cifrado não é
 * buscável por conteúdo — campo que o Operate precisa buscar não pode ser
 * `sensitive` na v1.
 */
export function createFieldCipher(provider: KeyProvider): FieldCipher {
  return {
    async encrypt(value) {
      const { keyId, key } = await provider.active();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return `${ENC_PREFIX}${keyId}:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
    },
    async decrypt(encoded) {
      if (!isEncryptedField(encoded)) throw new Error('valor não está cifrado no formato enc:v1');
      const [keyId, iv64, tag64, data64] = encoded.slice(ENC_PREFIX.length).split(':');
      const key = await provider.byId(keyId);
      if (!key) throw new Error(`chave '${keyId}' desconhecida do KeyProvider`);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv64, 'base64'));
      decipher.setAuthTag(Buffer.from(tag64, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(data64, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString('utf8'));
    },
  };
}
