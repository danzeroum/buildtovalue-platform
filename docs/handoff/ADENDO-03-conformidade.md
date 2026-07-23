# ADENDO-03 ao Plano v1.2 — Conformidade ISO/IEC 42001 e EU AI Act

> **Anexar a:** `docs/handoff/PLANO-buildtovalue-platform-v1.2.md` (após o ADENDO-02)
> **Data:** 2026-07-22 · **Status:** aguardando aprovação do dono → segue ao desenvolvedor
> **Fontes:** duas análises externas de conformidade (triadas), inspeção direta do código
> das migrações 0001–0005 e das levas F3, ADR-0002, ADENDO-02.
>
> **Enquadramento (importante):** a ISO/IEC 42001 certifica o *sistema de gestão* da
> organização, não o produto; o EU AI Act classifica o risco pelo *caso de uso do
> cliente*. O papel da plataforma é fornecer **capacidades e evidências** — e ela já
> fornece mais do que as análises reconheceram (ledger hash-encadeado com tombstones,
> trilha de fatos com supervisão humana D27/D28, kill-switch auditado D29 = interrupção
> do Art. 14, XES/IEEE 1849 no ar, definições imutáveis, reveal com motivo). Este adendo
> fecha as lacunas REAIS confirmadas no código e registra o que foi rejeitado e por quê.

---

## 1. Correções de fato sobre as análises (registrar em pendências)

As análises usaram snapshot desatualizado: o fencing formal de user task (`claim_token`,
D21) FOI entregue na leva 4 (PR #14) e a F2 está fechada com tag `phase-2`. As lacunas
aceitas abaixo são as que a inspeção do código de hoje confirma.

## 2. Decisões novas

- **D32 — Trilhas imutáveis POR PERMISSÃO DE BANCO, não por disciplina.** Migração
  **0006** (gate): `REVOKE UPDATE, DELETE ON history_events FROM app_api` (o runtime
  nunca os usa por design — custo zero, prova máxima) e criação de
  `tenant_audit_events` **INSERT-only** para `app_api`, com RLS + FORCE como as demais.
  Papel de migração continua separado (já é). Evidência para auditor: consulta aos
  grants + tentativa de UPDATE negada.

- **D33 — Trilha de auditoria de tenant (eventos sem instância).** A `history_events` é
  ancorada em instância; eventos de governança que NÃO têm instância ganham casa própria:
  `tenant_audit_events(id, tenant_id, actor, event_type, resource_type, resource_id,
  payload jsonb, request_id, created_at)` — append-only (D32). Eventos mínimos v1:
  autenticação relevante (login/logout/refresh negado), mudanças de configuração
  (inteligência do tenant D29, tools D31), **kill-switch** (acionar/reativar),
  exportações de auditoria, revelações agregadas. Os eventos do ADENDO-02 que já exigiam
  auditoria passam a ter tabela nomeada — era lacuna de destino, não de intenção.
  **Envelope padronizado de ator** em TODA auditoria (nas duas trilhas):
  `actor: { type: 'user'|'system'|'agent', id, requestId }` como campo de primeira
  classe consultável — nunca enterrado em payload variável. `ip`/`user_agent` só em
  eventos de autenticação, com nota LGPD: são dados pessoais → retenção mínima definida
  no registro de tratamento.

- **D34 — Contexto de usuário e decisões de autorização.** Bindings do pino ganham
  `user_id` (o `tenant_id` já existe). Tentativas **negadas** de autorização: log
  estruturado (usuário, recurso, ação, permissão exigida, resultado) + métrica de
  negações; **persistência em `tenant_audit_events` apenas para recursos de alta
  sensibilidade** (reveal, config de inteligência, tools, kill-switch, export de
  auditoria). Racional: gravar todo DENIED em banco é vetor de escrita sob ataque; o log
  estruturado já responde "A tentou B e foi negado pela política C".

- **D35 — Integridade por ancoragem de digest, não por hash-por-linha.** Periodicamente
  (job), o digest canônico de um intervalo das duas trilhas é **ancorado no ledger real**
  (mecanismo do ADR-0002; anchors externos S3/RFC3161 da biblioteca opcionais no piloto).
  Adulteração de qualquer linha do intervalo torna-se detectável sem custo por escrita.
  **Exports assinados** usam o mesmo mecanismo: digest do arquivo exportado ancorado no
  ledger com recibo verificável — nenhuma infraestrutura de chaves nova.

- **D36 — Exportação de auditoria.** `GET /v1/audit/export` (formatos JSON/CSV; filtros:
  período, ator, `event_type`, `resource_type`; tenant implícito do JWT; permissão nova
  `audit:export`, ela própria auditada). XES por instância já existe e permanece.
  **É extensão de contrato → entra na proposta da AG-2** (política 3.2), junto com as
  rotas de agente e a coluna de re-enfileiramento de dead-letter já registrada.

- **D37 — Dossiê de conformidade como artefato vivo.** `docs/compliance/dossie.md`
  mapeando capacidade → evidência → controle (ISO 42001) / artigo (EU AI Act: 12
  registros, 13 transparência, 14 supervisão humana e interrupção): RLS, append-only,
  ledger+tombstones, trilha de fatos, gates com escopo exato, kill-switch, budget,
  classificação/cifra/reveal, XES, export. Atualizado no fechamento de cada fase
  (uma linha no Definition of Done dos relatórios). É simultaneamente material de
  auditoria e de venda; a contraparte visual é objeto do briefing do designer
  (BRIEFING-designer-governanca).

## 3. Sequenciamento (não mexe na esteira atual)

1. **Migração 0006 (D32/D33)** entra no MESMO pacote de gate da AG-2 (que já terá
   migração de qualquer forma) — uma aprovação do dono cobre tudo.
2. **Leva de conformidade** (autônoma, sem migração além da 0006): envelope de ator,
   bindings `user_id`, negados em log+métrica, persistência dos sensíveis, job de
   ancoragem de digest (D35), dossiê v1 (D37).
3. **`/v1/audit/export`**: implementa após a proposta AG-2 aprovada (D36).
4. **Console de Auditoria (superfície)**: F4 — o export via API cobre o auditor na v1.

## 4. Gate de Piloto (8.4) — itens novos

10. Evidência das permissões append-only (dump dos grants + teste de UPDATE negado).
11. Arquivamento imutável de WAL/PITR configurado no Postgres gerenciado do piloto
    (item de infraestrutura, par do backup/restore já existente).
12. Export de auditoria demonstrado com recibo de ancoragem verificado.
13. Dossiê de conformidade v1 preenchido e revisado pelo dono.

## 5. Rejeições registradas (Anexo C — não reimplementar)

12. **Triggers de banco para auditoria.** A aplicação grava auditoria explícita com
    semântica de negócio na mesma transação; triggers capturariam diffs crus (incluindo
    cada update de `state` por avanço — ruído massivo), duplicariam a trilha e criariam
    segunda fonte de verdade. Auditoria explícita + append-only por permissão + ancoragem
    é estritamente superior.
13. **Hash encadeado por linha na trilha de auditoria.** Serializa escritas e duplica o
    ledger; substituído pela ancoragem periódica de digest (D35).
14. **Infraestrutura de assinatura digital própria para exports.** Substituída por
    digest ancorado no ledger com recibo (D35) — reusa `attestVersion`/anchors da
    biblioteca.
15. **Persistir toda negação de autorização em banco.** Vetor de escrita sob ataque;
    substituído pelo desenho do D34 (log estruturado + métrica + persistência seletiva).

## 6. Aceites nomeados desta frente

1. Teste: `app_api` recebe erro de permissão ao tentar UPDATE/DELETE nas duas trilhas.
2. Teste: evento de kill-switch/tool/config aparece em `tenant_audit_events` com
   envelope de ator completo; RLS de tenant verificada na tabela nova (suíte permanente
   passa a cobrir 15+ tabelas).
3. Teste: digest de intervalo ancorado; adulteração simulada de uma linha → verificação
   falha apontando o intervalo.
4. Teste: negação de reveal gera registro persistido; negação de rota comum gera só log
   estruturado com os cinco campos.
5. Export com filtros + recibo de ancoragem verificável ponta a ponta.
6. Dossiê v1 com a matriz capacidade→evidência→controle/artigo, revisado.
