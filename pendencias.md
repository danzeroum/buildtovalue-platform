# Pendências — decisões e bloqueios para o dono analisar

> Mantido pelo desenvolvedor sob o regime de autonomia (2026-07-22): PRs
> estratégicas com merge em CI verde; o que exige VOCÊ fica aqui.

## 1. ~~BLOQUEIO — publish no npm~~ RESOLVIDO (22/07, Release #4 verde)

**Encerrada.** Secret corrigido pelo dono; trem `-next` completo no registry
(engine@1.1.0-next.1, core@1.2.0-next.0, forms/forms-react@1.0.0-next.0 e a
biblioteca). F1.8 fechado na sequência com o engine pinado exato. Histórico
abaixo mantido para auditoria.

### (histórico)

**Único item que trava o fechamento da F1.** ATUALIZAÇÃO (Release #2,
22/07 12:42 UTC): o pipeline inteiro está provado — gate de 28 projetos
verde, guarda pre-mode-aware passou — e o publish morreu com `ENEEDAUTH`:
**o secret `NPM_TOKEN` não resolveu no runner** (chegou vazio). Checklist:

1. Repo `bpmn` → Settings → Secrets and variables → **Actions** →
   *Repository secrets* → nome EXATO `NPM_TOKEN` (environment/Dependabot/
   Codespaces secrets não valem para este workflow).
2. Token do npm tipo *Automation* (ou granular com **Read and write** na
   org `@buildtovalue`), não expirado.
3. Re-executar `release.yml` com dry-run desmarcado. A PR bpmn#168
   (fail-fast) faz futuras ausências do secret falharem em segundos com a
   mensagem exata, em vez de após 4min de gate.

- **O que preciso de você (um dos dois):**
  - (a) rodar `release.yml` na UI do Actions da `main` do `bpmn` com
    **dry-run desmarcado** — publica `engine@1.1.0-next.0` (e
    `forms@1.0.0-next.0` quando a PR das forms mergear); pacotes já
    publicados nas mesmas versões são pulados; **ou**
  - (b) conceder `actions: write` à integração (recomendação da sua própria
    triagem: elimina o gargalo recorrente; o gate humano continua sendo a
    revisão de PR antes do merge na `main`).
- **O que destrava:** pino exato do engine na plataforma (D5) → crash test
  das 100 instâncias → fechamento F1.8 → tag `phase-1` → F2.
- **Pré-requisito já satisfeito:** a `main` do `bpmn` contém o engine
  (PR #165 de restauração — o merge original da #162 às 01:39 UTC capturou
  só os docs; os commits do engine entraram na branch DEPOIS. Restaurados
  por cherry-pick, revalidados sobre a main pós-SL-12/13).

## 2. Decisões tomadas em autonomia (validar quando puder — nada bloqueia)

1. **Refresh token opaco prefixado** `${tenantId}.${segredo}` (resolve o
   contexto RLS no refresh sem tabela global; só o hash persiste).
2. **`instances.definition_ref` é TEXT** (`'skeleton@1'`) até a F2
   introduzir `process_definitions`/registry — comentado na migração 0002.
3. **`jobs.wait_key UNIQUE`** como âncora do exatamente-uma-vez na criação
   de jobs sob re-dispatch (complementa a UNIQUE de `effect_key` na outbox).
4. **`forms.date` = data-calendário ISO `YYYY-MM-DD`** sem hora/fuso
   (campo de data com hora entraria como tipo novo em minor).
5. **Storybook do forms-react**: instalado como devDependency do monorepo
   público (peso de install considerável) — se preferir Storybook em repo
   separado ou docs estáticos, dá para mudar depois sem tocar no renderer.
6. **(F2.1) Avaliador de condição v1 do host** = igualdade de literais
   (`variavel = true|false|número|"texto"`); expressão fora disso retorna
   erro → incidente (fail-fast D19, nunca rota silenciosa). É a costura
   onde o S-FEEL da biblioteca entra na F3 junto do deploy de definições.
7. **(F2.1) `example@1` embutido** no registro de definições (mesmo caminho
   do `skeleton@1`) — vira o processo exemplo do aceite da F2; o deploy real
   via `process_definitions` + lint D19 continua na F3.
8. **(F2.1) Relógio da varredura de timers é o INJETADO do host** (não o
   `now()` do banco): o mesmo instante decide o vencimento e carimba o
   evento TimerFired — testes determinísticos, D2 coerente. A marcação
   'fired' acontece na MESMA tx do avanço (sem janela de crash).
9. **`seq` da história — aritmética COMPLETA (semântica que XES/Operate
   consomem; atualizado na leva 2 da F3):**
   - Efeitos do engine (dispatcher): `seq = revision × 100000 +
     effect_index` (índices 0..N, N pequeno) — determinístico sob
     re-dispatch (crash reproduz o MESMO seq; UNIQUE de effect_key dedup).
   - Auditoria do host (reveal/patch/reatribuição): faixa RESERVADA
     `revision × 100000 + 90000 .. +99999` (10.000 slots por revision),
     MAX+1 serializado por FOR UPDATE na instância, com GUARDA EXPLÍCITA:
     estourar a faixa = erro alto, nunca overflow invadindo a revision
     seguinte. UNIQUE(instance_id, seq) é o guarda-corpo físico.
   - Ordem total por instância = ordem numérica de seq; dentro de uma
     revision, efeitos do engine (0..N) precedem auditoria (90000+).
10. **(F2.4+) `FIELD_KEY_SECRET`** é o KeyProvider de dev/CI (D20): scrypt →
    AES-256-GCM por registro. Sem ele, gravar um campo `sensitive` ABORTA a
    tx (nunca plaintext silencioso). KMS por tenant continua na F5; chave
    estática em produção reprova o gate (registrado no código e no .env).
11. **(F2.4+) Fencing formal de USER TASK** (claim_token, D21) fica para a
    F3 junto da API de tasklist — na F2 a conclusão dupla é rejeitada pelo
    engine (staleWait). Registrado no fase-2.md para a sua triagem.
12. **(F2.4+) Salt-por-registro** (ADR-0002 item 3) entra com a integração
    do ledger real (@buildtovalue/audit, V1 §8.3) — na F2 nenhum hash de
    conteúdo é gravado, e o teste nomeado do ledger já vigia o invariante.

## 2.1 ~~ADR-0002~~ APROVADO (22/07) — teste do ledger vira entregável nomeado da F2

`docs/architecture/ADR-0002-tombstones-ledger-lgpd.md`: Anexo B adotado
(conteúdo fora do ledger + tombstone de eliminação + salt por registro),
com as alternativas B/C e trade-offs. A política 3.2 pede sua aprovação —
a implementação da costura (KeyProvider + teste "ledger sem conteúdo
pessoal") entra na F2 assim que aceitar (ou ajustar).

## 2.3 D1 REVISADO pelo dono (22/07) — visibilidade do repo

**"D1 revisado em 22/07: público até o fechamento da v1; retorno a Private
é ITEM DO GATE DE PILOTO (8.4)."** — decisão consciente e temporária do
dono (acesso direto do arquiteto e analistas). Linha correspondente
adicionada ao checklist vivo `docs/privacy/gate-piloto.md` (item 6).
Verificação de visibilidade passa a ser pelo MÉTODO EXTERNO (selo do
cabeçalho / 404 anônimo), executada pelo desenvolvedor.

## 2.2 Tag `phase-1` — push bloqueado pelo proxy (ação SUA, 1 min)

O proxy git da sessão só aceita push na branch designada; `git push origin
phase-1` respondeu HTTP 403. A tag existe LOCALMENTE em `e940fe5` (a main
mergeada da PR #4). Crie pela UI (Releases → "Create a new release"/tag
`phase-1` sobre `e940fe5`) ou libere tag-push para a integração.

## 2.4 ADENDO-02 (22/07) — registros mandados pela sua mensagem

- **D26 — critério de lançamento REVISADO:** a v1 passa a ser F3 + F-AG
  (agentes/squads) + Gate de Piloto. **Lacuna corrigida:** agentes e squads
  não constavam do plano v1.2 até 22/07 — o ADENDO-02 é o documento
  governante da frente (D26–D31 + aceites nomeados + 3 itens novos no gate).
- **AG-1 JÁ ESTAVA ENTREGUE quando o ADENDO-02 chegou:** o Handoff 22
  (SL-1..SL-13) foi implementado e mergeado na main do bpmn nesta mesma
  data (PRs #163/#164), com RECONCILIACAO.md preenchida (11/11 critérios ✅)
  e o trem `-next` publicado já contendo a Squad Lane. O caminho crítico da
  F-AG encurtou: próximo passo é a proposta de contrato da AG-2 (após o
  fase-3.md). Checkpoint detalhado enviado em 22/07.
- **Retry de dead-letter (leva 5):** `POST /v1/incidents/{id}/retry`
  re-arma jobs failed; efeito em dead-letter NÃO é re-enfileirável na v1 —
  a fila é efêmera e o payload do efeito não é guardado no incidente.
  Re-enfileirar exige coluna nova em `incidents` (payload) = migração =
  GATE. Candidata a entrar na migração da AG-2. A rota responde 409
  honesto apontando /resolution.

## 2.5 Console D23 (leva 6, PR2 /tasks + /operate) — lacunas protótipo × contrato

Implementei o console **fiel ao contrato /v1 já aprovado**; onde o protótipo
(baixa→média fidelidade, G-UX-3) pede algo que o contrato não tem, registro
aqui em vez de inventar shape (disciplina D19 + regra "pergunta antes do
merge" para desvio de contrato — aqui NÃO há desvio de contrato, só do
protótipo).

- **«Aprovar/Reprovar» como dois botões (tela 01):** a conclusão
  (`POST /v1/user-tasks/{id}/completion`) valida a submissão contra o form
  PINADO e **rejeita chave desconhecida** (`validateSubmission` — "campo
  desconhecido"). Logo, NÃO dá para injetar um `approved` fora do schema: o
  console entrega **«Concluir tarefa»** (submete o form validado; se o
  processo modela a decisão, ela é um CAMPO do form e o gateway ramifica).
  Um approve/reject de primeira classe exige **extensão de contrato**: um
  campo reservado de decisão no schema OU um `decision` no corpo da
  conclusão. → **candidato à proposta da AG-2** (junto de dead-letter
  payload e fencing D28).
- **Rótulo humano da tarefa na lista:** `taskSummary` traz `elementId` +
  `formRef`, não o rótulo do elemento no diagrama nem o nome do processo. A
  lista mostra `elementId`/`formRef` (honesto); rótulo humano exigiria juntar
  o diagrama por definição — enriquecimento futuro, não some do fluxo.
- **Cartões de métrica do /operate (128 ativas, p95…):** não há endpoint de
  contagem/agregação na v1, e o **p95 é medido na leva 7**. O console NÃO
  fabrica totais — mostra lista + drill-down. Agregações = candidatas a um
  endpoint de métricas (pós-v1).
- **Edição de variável pelo operador (`PATCH …/variables`, leva 2):** existe
  no servidor; o console PR2 expõe **revelação** (núcleo do D20) + exibição,
  não edição de variável de instância em voo (ferramenta afiada, fora do
  protótipo). Edição via console = follow-up.
- **RBAC: `instances:start` sem `definitions:read` (revisão adversarial da
  PR2):** o papel **business** tem `instances:start` mas NÃO `definitions:read`.
  O «Iniciar processo» (tela 05) lista definições via
  `GET /v1/process-definitions` (`definitions:read`) → business receberia
  **403** e não conseguiria escolher o que iniciar. **Decisão de UX aplicada:**
  o console exige `instances:start` **E** `definitions:read` para mostrar o
  botão — não oferece um botão que dá em beco (revisão adversarial). Isso
  DESVIA do protótipo ("visível para papéis com permissão de start"), porque o
  contrato de RBAC torna o fluxo impossível para business. **Decisão do dono
  (RBAC = GATE):** (a) conceder `definitions:read` ao business (o botão volta a
  aparecer para ele); (b) um endpoint de "definições iniciáveis" escopado por
  `instances:start`; ou (c) retirar `instances:start` do business.

**Correções aplicadas na revisão adversarial da PR2 (antes do merge):** ações
de trabalho de tarefa gated por `tasks:work` (papel sem ela vê somente
leitura); «Exportar XES» e abas Incidentes/Jobs/Timers gated por `operate:read`
(o resto do Operate degrada com graça); cancelamento gated por `operate:act`
(igual à rota); **D20 fail-closed** nas variáveis (mascara por
`classification==='sensitive'` OU `masked`, nunca confia num só sinal);
Idempotency-Key estável por sessão do modal de início (re-tentativa não duplica
instância).

## 3. Registro de fluxo (sem ação sua)

- **~~Follow-up bpmn~~ RESOLVIDO (PR bpmn#169, mergeada 22/07):**
  ENGINE_VERSION derivada do package.json no build + no version-packages,
  com teste de sincronia; corpus de replay regenerado localmente. A
  correção viaja no próximo publish do trem -next.
- **Absorvido pela F2 (triagem 22/07):** StateMigrator sai de stub, com o
  caso "state_schema_version antiga demais → incidente" no aceite.
- **Follow-up infra:** smoke containerizado do compose.dev.yml em máquina
  com Docker (este ambiente não tem daemon; processos validados contra PG
  real) — fase-1.md registra a ressalva.

- Issue #2 deste repo: regra de lint D19 "boundary só sobre atividade de
  espera" (alvo F3.1), com casos de teste.
- Ensaio de restore documentado em `docs/runbooks/database.md` (2026-07-22)
  — item de aceite da F1 que a triagem pediu para não perder de vista.
