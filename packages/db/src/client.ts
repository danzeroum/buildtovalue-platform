import postgres from 'postgres';

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

/** Conexão da APLICAÇÃO (papel app_api, sujeito a RLS — D7). */
export function createDb(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: () => {},
  });
}
