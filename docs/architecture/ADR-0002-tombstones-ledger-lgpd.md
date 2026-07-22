# ADR-0002 — Tombstones: ledger imutável × direito de exclusão (LGPD art. 18)

> **Status:** PROPOSTO — decidir na F2 (política 3.2); implementação plena na
> F5 (LGPD avançada). Base: Anexo B do PLANO v1.2, adotado integralmente;
> alternativas com trade-offs abaixo. Registrado em `pendencias.md` para
> aprovação do dono.

## Contexto

O ledger hash-encadeado da biblioteca (`@buildtovalue/audit`) é imutável por
construção — qualquer alteração quebra o `verify()`. A LGPD dá ao titular o
direito de exclusão. As duas coisas convivem SE o ledger nunca contiver o que
precisa ser excluído.

## Decisão proposta (Anexo B)

1. **O ledger NUNCA armazena conteúdo pessoal** — só hashes, referências e
   metadados de governança. Teste automatizado na F2 (fixture com dados
   pessoais atravessando o fluxo → varredura do ledger falha se qualquer
   valor aparecer em claro).
2. Conteúdo vive em `variables`/`user_tasks.payload` (tabelas mutáveis, RLS).
   **Exclusão = anonimização** dos campos `personal`/`sensitive` **+
   tombstone no ledger**: `{type:'erasure', subjectRef, refs[], reason,
   requestedAt}` — a cadeia íntegra passa a PROVAR QUE a eliminação ocorreu.
3. **Hash de conteúdo usa salt por registro, armazenado JUNTO ao conteúdo**:
   apagados conteúdo+salt, o hash residual no ledger não é reversível nem
   verificável por força bruta (sem o salt, dicionário não confirma nada).
4. Limitação registrada (D20): campo `sensitive` cifrado NÃO é buscável por
   conteúdo — campo que o Operate precisa buscar não pode ser `sensitive`
   na v1.

## Alternativas consideradas

- **A (proposta): conteúdo fora do ledger + tombstone + salt por registro.**
  Prós: `verify()` intacto; exclusão real; cadeia vira evidência da
  eliminação (G-LGPD-4). Contras: disciplina permanente de "nada pessoal no
  ledger" — por isso o teste automatizado é parte da decisão.
- **B (rejeitada no Anexo B): crypto-shredding dentro do ledger** (cifrar
  entradas e destruir a chave). Contras decisivos: acopla gestão de chaves à
  cadeia, quebra o `verify()` existente da biblioteca pública e transforma
  todo backup do ledger em material regulado.
- **C (rejeitada): reescrita da cadeia com re-hash.** Destrói a propriedade
  de auditoria que é o diferencial do produto; âncoras externas (anchor-git/
  rfc3161/s3) ficariam permanentemente divergentes.

## -ilities (G-ARQ-1) e trade-offs (G-ARQ-2)

Conformidade (art. 18) e auditabilidade preservadas simultaneamente;
manutenibilidade alta ("ledger não guarda conteúdo" é uma regra só);
custo: um salt por registro pessoal + a disciplina testada — aceito
conscientemente contra a alternativa de acoplar KMS à cadeia.

## Consequências

- F2: costura — `KeyProvider` (D20) para `sensitive`; teste "ledger sem
  conteúdo pessoal"; salt por registro no armazenamento de conteúdo.
- V1 (8.3): export JSON por titular; exclusão = anonimização + tombstone.
- F5: portal do titular, retenção+expurgo auditado, KMS por tenant.
