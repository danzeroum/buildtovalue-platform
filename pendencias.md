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

## 2.6 ~~Avaliador de expressão: servidor × preview DIVERGEM~~ FECHADA (colapso §2.7)

**Encerrada.** O servidor e o console agora importam o MESMO
`formExpressionEvaluator` de `@buildtovalue/forms@1.0.0-next.1` — a divergência
(servidor só-igualdade × preview rico) não existe mais. As cópias locais foram
apagadas (ver §2.7). O seed do demo voltou a usar comparações + `and`/`or`
(`value > 0 and value <= 50000`, `valor > 5000 or decisao = "reprovar"`) e passa
igual nos dois lados. Diagnóstico histórico abaixo mantido para auditoria.

### (histórico)

Pergunta do dono na triagem final — **confirmada**:

- **Servidor** (`validateSubmission` na conclusão de user task,
  `packages/db/src/runtime/userTasks.ts:224`) injeta o `conditionEvaluator`
  (`runtime/definitions.ts:77`) — o MESMO avaliador de GATEWAY do engine, que
  suporta **só `variavel = literal`** (igualdade; regex `^var = literal$`).
- **Preview do console** (`apps/console/src/sfeel.ts`) usa `consoleEvaluator` —
  suporta comparações (`> >= < <= != =`) e `and`/`or`.

**Consequência:** um form com `visibleWhen: 'valor > 5000'` ou
`validation: 'value > 0 and value <= 50000'` (como o protótipo mostra) desenha
certo no preview mas **reprova no servidor (422 "visibleWhen inválida")** na
conclusão. O avaliador de gateway (igualdade, subconjunto v1) está CERTO para
gateways; o BUG é o servidor **reusar** o de gateway para FORMS.

**Correção (D10 — fonte única):** `@buildtovalue/forms` exporta o avaliador de
FORM (comparações+and/or) e os DOIS lados consomem — console e o
`validateSubmission` do servidor; apaga as duas cópias. É minor de biblioteca
(bpmn) + consumo na plataforma → proponho como **item da AG-2.1** (v2 §4).
Interim aplicado: o form do seed do demo usa só igualdade (`visibleWhen
decisao = "reprovar"`), então o runbook conclui sem 422.

## 2.7 ~~Avaliador de forms — coexistência transitória~~ COLAPSADA (fonte única)

**Encerrada.** Publicado `@buildtovalue/forms@1.0.0-next.1`, o colapso foi
executado: `db`/`api`/`console` subiram a dep para `1.0.0-next.1` (engine segue
pinado em `1.1.0-next.1`); servidor e console importam `formExpressionEvaluator`
+ `@buildtovalue/forms/corpus`; as três coisas locais foram **DELETADAS**
(`packages/db/src/runtime/formEvaluator.ts`, `apps/console/src/sfeel.ts`,
`packages/db/tests/fixtures/sfeel-corpus.ts`). O teste
`apps/api/tests/form-evaluator-equivalence.test.ts` virou **regressão contra a
canônica** — roda o corpus publicado E falha se qualquer cópia local reaparecer.
Plano histórico abaixo mantido para auditoria.

### (histórico do plano de colapso)

Precedente: **Anexo C item 2** (o mesmo tratamento de `simulation × engine` —
duas implementações vivendo juntas sob teste de equivalência até o colapso).

**Estado atual (3 implementações, ancoradas a UM corpus):**
- **canônica** — `@buildtovalue/forms` `formExpressionEvaluator` (bpmn, branch
  `claude/...decvzt`), default de `validateSubmission`; changeset `minor`
  (`forms-canonical-evaluator.md`). Testada na bpmn contra `SFEEL_FORM_CORPUS`.
- **servidor** — `packages/db/src/runtime/formEvaluator.ts` (cópia rica; a
  conclusão de user task já a usa, fechando a §2.6 no runtime real).
- **console** — `apps/console/src/sfeel.ts` `consoleEvaluator` (inalterado).
- **corpus compartilhado** — `SFEEL_FORM_CORPUS` na bpmn é a FONTE, publicada no
  subpath **`@buildtovalue/forms/corpus`** (fixture fora do bundle de runtime); o
  espelho byte-a-byte vive em `packages/db/tests/fixtures/sfeel-corpus.ts` e o
  teste `apps/api/tests/form-evaluator-equivalence.test.ts` afirma **servidor ≡
  console ≡ corpus** (bidirecional). A canônica roda o mesmo corpus na bpmn — as
  três não podem divergir.

**PONTO DE COLAPSO (nomeado) — após publicar `@buildtovalue/forms@1.0.0-next.1` (o minor entra como incremento de prerelease no modo `next`):**
1. subir a dep nos 3 `package.json` da plataforma (db, api, console);
2. servidor (`userTasks.ts`) e console (`tasks.tsx`) passam a importar
   `formExpressionEvaluator` da biblioteca;
3. **DELETAR** as CÓPIAS do avaliador — `packages/db/src/runtime/formEvaluator.ts`
   e `apps/console/src/sfeel.ts` (consoleEvaluator) — **E o espelho do corpus**
   `packages/db/tests/fixtures/sfeel-corpus.ts`;
4. o teste de equivalência importa `SFEEL_FORM_CORPUS` de
   **`@buildtovalue/forms/corpus`** (fonte única) e sobrevive como **regressão
   contra a canônica** — sem espelho, sem risco de drift silencioso;
5. só ENTÃO restaurar expressões ricas no `seed-demo.ts` (o demo mostra o poder
   real, não o interim) — e a §2.6 fecha de verdade.

**Release do bpmn (ação do dono no gate):** `changeset` já commitado →
`pnpm version-packages` (gera a PR de versão) → **merge da PR de versão** →
`release.yml` publica. Lembrete do guarda que travou o **Release #1** (o job de
publish exige o build verde de TODOS os pacotes + o `NPM_TOKEN`; o `pre.json`
mantém a tag `next`). **Se o `workflow_dispatch` ainda devolver 403** pelo proxy,
me avise que **você dispara pela UI do Actions** (mesmo procedimento do
`phase-1`, §2.2).

**Composição da PR de versão (bpmn#170) — corte final:** o `version-packages`
batia num acoplamento: bumpar o engine (`next.1→next.2`, changeset pré-existente
`ENGINE_VERSION`) quebrava 5 cenários do corpus de replay **D6** só na string de
versão. Resolvido pela raiz (ver §2.8). A #170 publica os **dois juntos**:
`forms@1.0.0-next.1` + `engine@1.1.0-next.2`; nenhuma aceitação nomeada regenerada.

## 2.8 D6 REFINADO — replay compara projeção semântica, não versão

**D6 refinado — o replay compara a projeção semântica do estado; `engineVersion`
é gravada e verificada por asserção própria, não por igualdade byte-a-byte.
Motivo: metadado de versão fazia o gate disparar por não-semântica e empurrava
para regeneração rotineira do corpus** (e é na regeneração que uma regressão
semântica real passaria batida, misturada às trocas de string). Feito em
`packages/engine/tests/replay.test.ts` (bpmn): normaliza SÓ `engineVersion`;
`stateSchemaVersion` segue byte-a-byte (é semântico — bump exige `migrateState`,
D14). As fixtures NÃO foram regeneradas (passam em next.1 e next.2).

**Pino do engine na plataforma:** a plataforma **NÃO** sobe para `engine@next.2`
agora — continua pinada em `1.1.0-next.1` até um **upgrade deliberado** com o gate
de conformidade/replay (D5 + §9.3). O release da #170 publica o engine; o consumo
na plataforma é decisão à parte.

## 2.9 bpmn — dist-tag `latest` aponta para prerelease (ação no repo bpmn)

Observado pelo dono no publish: no npm, a dist-tag **`latest`** de
`@buildtovalue/forms` (`1.0.0-next.1`) e de `@buildtovalue/core` (`1.2.0-next.0`)
está apontando para **prerelease**. Prereleases devem sair sob a tag **`next`**,
com `latest` reservada à última **estável**. Não bloqueia a plataforma (as deps
são pinadas por versão exata, não por tag), mas engana `npm install pkg` sem
versão. **Ação (bpmn, quando conveniente):** ajustar `publishConfig.tag`/fluxo do
`release.yml` para publicar prereleases só em `next` (o `pre.json` já usa a tag
`next` no changesets — o desalinhamento é no passo de publish/`npm publish
--tag`). Registrar o fix no changelog do bpmn.

## 2.10 AG-2.2 — caminho de grafo em PAYLOAD (COLAPSADO na etapa 3) ✅

O AgentRunner (etapa 2) caminhava o grafo agentflow por um **resolver injetado**
(`resolveGraph`) cujo stub lia o grafo do **payload do job** (`fromPayload:true`),
com guarda dura em produção (`blocked: 'ungoverned-graph'`). Grafo de payload era
NÃO-GOVERNADO (sem `validateGraph`/versão/lint).

**COLAPSO FEITO (etapa 3, migração 0007):** o caminho de payload foi **DELETADO**.
- `AgentJobInput.graph` e o par `fromPayload`/`ungoverned-graph` **saíram**; o
  resolver de produção (worker) resolve `agentRef` contra `agent_definitions`
  (`getAgentDefinitionByRef`) — grafo **governado** (validateGraph passou no deploy).
- Ausência de grafo no registry = parada honesta `no-graph` (nunca corrida com
  grafo não-governado). `runAgentJob`, walker e os testes de walk/budget/kill-switch
  ficaram intactos (só a fonte do grafo mudou; injeção por closure nos testes).

**SEAM REMANESCENTE (não-bloqueante, engenharia AG-2):** quem materializa o job
`type:'agent'` a partir do `agentTask` é o **engine** (`@buildtovalue/engine`), que
ainda NÃO emite `CreateJob{jobType:'agent'}`. O **pin** já é resolvido e gravado no
START (`recordAgentPinsAtStart` → `history_events.agentPinResolved`, incidente
`agentUnpublished` se a ref não publica); quando o engine emitir o job de agente,
o payload carrega `agentRef` = o **pin efetivo** (nunca a ref flutuante) — a
resolução flutuante acontece UMA vez no start, jamais por execução de job.

**Trilha mascarada (etapa 3 §2, feita + gate do designer):** `persistAgentTrail`
grava o I/O em `history_events.agent_io`, **conservador por padrão** (só passa
campo `none`; sensitive/personal/desconhecido → `MASKED_VALUE`). TESTE DE VAZAMENTO
(`agent-trail-leak.test.ts`) falha se qualquer valor pessoal aparecer.
Dois requisitos do designer travados **desde já** (append-only não perdoa retro):
- **(a) um fato por linha:** cada elo da cadeia D1 (`intenção → ação(por nó) → I/O
  → [decisão] → evidência` + `parada`) é UMA linha, com `kind = agent:<elo>`
  (filtrável por `kind LIKE 'agent:%'` sem abrir payload). `buildAgentFacts` emite
  a cadeia; `decisao` entra quando o walker surfaçar o nó (a coluna já suporta).
- **(b) envelope de ator D33** `{type,id,requestId}` em CADA fato de agente (e no
  `agent:pinResolved` = `system/runtime`), no payload jsonb — **consultável** por
  `payload->'actor'->>'type'`, sem coluna nova. A P2/P7 da AG-3 monta sem migração.
Seam remanescente: o `io.input` (variáveis da instância) só é surfaçado quando o
engine passar as vars ao job (etapa 4, §2.11) — hoje a trilha grava `io.output`
real; a máscara já cobre input+output.

**Lote de mudanças na biblioteca (agentflow, um único release):** para não gastar
uma ida-e-volta de publicação por etapa, AGRUPAR num só changeset/minor:
- `FactSource` += `'evidencia-verificada'` (D30, aceite 5) — só o `run` real emite;
  simulação NUNCA (teste do aceite);
- **emissão de `agentTask` (etapa 4):** o engine trata `agentTask` como ESPERA que
  emite `CreateJob{jobType:'agent'}` + `agentRef` efetivo (extensão determinística
  do avanço; NADA do interior do agente entra no engine);
- **elo `decisão` da cadeia D1 (nota do designer):** hoje `buildAgentFacts` NÃO emite
  `decisao` — falta o walker expor o TIPO do nó. Se depender do agentflow, entra no
  mesmo lote (a cadeia incompleta vira lacuna visível quando o P2 desenhar a timeline);
- o que a etapa 5 revelar (gate de tool D31 — `effectRequiresGate`).
Peço **um** release do bpmn quando o lote fechar, não três improvisados.

## 2.11 AG-2.2 etapa 4 — elo engine↔runtime + fronteira D27 (unificados)

O elo que hoje falta (ponto honesto do gate da etapa 3): o engine não emite job de
agente, então o `agentTask` nunca materializa e o runtime da AG-2.2 está desconectado.
A etapa 4 fecha isso JUNTO com a fronteira D27 do replay:
1. **bpmn (no lote acima):** `agentTask` = espera que emite `CreateJob(agent)` com o
   **`agentRef` efetivo** (o pin da slice 2 viaja no payload do job); **confirmar que
   o formato bate com o que o worker espera** (`payload.agentRef` + `payload.elementId`).
   Declarar no changeset **o que passa a ser exposto** ao job (as variáveis da instância
   que alimentam o agente — resolve o ponto honesto (2), o `io.input` da trilha).
2. **fixtures de replay NOVAS** provando o avanço AO REDOR do agentTask, byte-idêntico:
   `start → agentTask emite CreateJob(agent) → JobCompleted → avanço segue`.
3. **lint do aceite 7 (invariante testada pelos DOIS lados):** nenhuma fixture de replay
   contém interior de `agentTask` — proibição VERIFICADA, não só declarada.

## 2.12 shared-ui — refino de forma do designer (PR PRÓPRIA, pós-#23)

Sete itens DIRETOS aprovados pelo designer (forma, não passam por adendo). Decisão
minha: **PR própria** após o merge da #23 (não contaminar o gate de backend). Itens:
1. Renomear tokens de papel: `--ui-role-gate-*` (decisão/gate) ≠ `--ui-role-warning-*`
   (aviso) ≠ classificação (escala própria). Mesma cor hoje, divergível amanhã.
2. `--ui-role-agent-*` (violeta) com teste AA AGORA — antes da AG-3, senão nasce ad-hoc.
3. Piso 44px de alvo de toque: `.decision-option` (~28px), `.chip`, `.palette-pill`,
   `.segment`. O gate P1 herda o mesmo controle → corrigir aqui corrige lá.
4. Microcopy: "Liberar" = soltar a própria tarefa (unclaim); "Reatribuir" = passar a
   outrem; **aposentar "Desatribuir"** (três palavras para dois atos).
5. Rótulo humano no chip de decisão (hoje mostra `aprovar` cru minúsculo); o valor cru
   segue sendo o dado auditado. Se o processo fornecer rótulo, usa; senão formata.
6. Remover `var(--ui-surface-raised, #fff)` — o cabeçalho do app.css declara "nenhum hex".
7. Forma canônica do controle: `DecisionOption {value, label, intent}`, cor pela intenção
   e só quando conhecida (user task = routing dourado; gate P1 = affirmative/destructive/
   neutral). O item a NÃO deixar passar — evita a AG-3 falar duas línguas.

## 2.13 ESCOPO registrado como F4 (muda comportamento — vira adendo se virar v1)

Três pedidos que TOCAM contrato/schema/permrissão — **não implementar** na v1:
1. **Intenção por rota na publicação** (colorir "Reprovar" na user task): exige campo de
   intenção por rota no schema+contrato do processo. Hoje a cor da decisão sai só quando
   a intenção é conhecida (item 7 acima); "colorir Reprovar" é a fonte da intenção, F4.
2. **Seletor de pessoas na reatribuição:** precisa de endpoint de MEMBROS do papel
   candidato (`GET` de candidatos). Hoje a reatribuição é digitação de id (risco
   typo→pessoa errada, anotado). F4 quando o endpoint existir.
3. **Iniciar versão anterior deliberadamente:** rollback permissionado — a projeção
   iniciável é latest-per-name de propósito (AG-2.1 etapa 5). F4/F5.
Se algum virar necessidade da v1, **vira adendo** (passa pelo plano, não direto ao dev).

## 2.14 Contrato — notas do designer que viram interface (registrar no shape)

1. **Namespace `agent:*` no catálogo de event_type (D33):** o prefixo `agent:` das
   linhas de trilha (`agent:pinResolved`, `agent:intencao|acao|io|decisao|evidencia|
   parada`) virou INTERFACE no momento em que a timeline passou a ser filtrada por
   `kind LIKE 'agent:%'`. Publicar no catálogo de `event_type` do contrato (insumo
   AG-2 já pedia catálogo estável) — não é mais detalhe interno.
2. **AG-2.3 (export) — normalização do envelope de ator:** o envelope `{type,id,
   requestId}` existe em DUAS formas físicas — COLUNAS em `tenant_audit_events`
   (`actor_type/actor_id/request_id`) e JSONB em `history_events`
   (`payload->'actor'`). O `GET /v1/audit/export` deve NORMALIZAR as duas numa só
   forma na saída — o auditor nunca recebe dois formatos para o mesmo conceito.
   Fixar no SHAPE da rota ANTES de implementar (senão vira retrabalho no export).

## 2.15 AG-2.2 etapa 5 (D31) — isenção do btv:gate no lint de cobertura de tool ✅ APROVADA (reversível)

**Decisão do dono (23/07): APROVADA e reversível.** No `deployProcessDefinition`
(`packages/db/src/registry/store.ts`), o coletor de `gatedElementIds` do lint
`EXEC_TOOL_EFFECT_UNGATED` passa a **pular nós `btv:gate`**: um gate que declara o
`toolRef` que **governa** (fonte do world-delta do payload) É o próprio gate — exigir um
btv:gate **a jusante do próprio gate** seria recursão. A cobertura do efeito irreversível
continua vindo da **autonomia do agente a montante** (`lintAgentGates` / `reachableGateFrom`)
e da posição do gate antes do `serviceTask` que executa. Provado no `agent-gate-e2e`
(o deploy do gate-proc passa; o efeito só roda a jusante do gate aprovado, sob selo).
**Reversível:** se preferir outra forma de ligar a tool ao gate (ex.: `toolRef` num nó
dedicado a montante em vez do próprio gate), é troca localizada no coletor + no gate-open.

## 2.16 AG-2.2 etapa 5 — dois candidatos a [ESCOPO] (decidir com o designer: etapa 5 ou AG-3)

Levantados no fechamento do backend; descritos com CUSTO no inventário de superfícies
(`docs/handoff/ag2-etapa5-inventario-superficies.md` §5) para a revisão G-UX-3.

1. **`agentProposalExpired` persistido (hoje só 409).** A marcação do designer trata
   "proposta expirada" como **estado com voz + ação ("reavaliar")** — para a UI pintar,
   precisa ser consultável, não só o erro no ato de aprovar. **Custo:** SEM migração —
   emitir um incidente `kind='agentProposalExpired'` (âmbar) quando o D28 recusa a
   aprovação (tabela `incidents` já existe; `payload` já existe). Fio: ~1 ponto no
   `completeUserTask` (no ramo `proposalExpired`) + o Operate lê o incidente. Leitura
   antecipada do dono (23/07): **provavelmente entra na etapa 5**.
2. **Reproposta sem rota exposta.** A Q4 fechou em "ação explícita + cap duro"; sem rota,
   a **ação explícita não existe** (só a função `requestReproposal`, testada). **Custo:**
   SEM migração (`instance_gate_state.reproposal_count` já existe) — uma **rota nova**
   `POST /v1/agents/reproposta` (ou `…/gates/:id/repropose`), `operate:act`, que chama
   `requestReproposal` (respeita o cap → estourou = parada honesta "reavaliação manual"),
   grava fato na trilha e consome budget novo. Fio: rota + método no facade + fato.
   Leitura antecipada do dono (23/07): **provavelmente entra junto**.

Decisão final (etapa 5 × AG-3) é sua com o designer, após a revisão G-UX-3.

## 2.17 AG-2.2 etapa 5 — LIMITAÇÃO DECLARADA v1: laço com espera (D37) + item nomeado AG-3

Achado no desenho da reavaliação de proposta (Q4), **generalizado**: não é de agente, é do
par **engine/host**. O engine preserva a identidade do token em movimento simples
(`leaveAlong`: aresta única → mesmo `token.id`); o host ancora o exatamente-uma-vez em
`wait_key = ${elementId}:${tokenId}` (UNIQUE + `ON CONFLICT DO NOTHING`, §2.3). Um laço que
re-entra num elemento de **espera** (userTask/serviceTask/agentTask/timer) repete o `wait_key`
→ o job/task não é recriado e o engine trava esperando um efeito que nunca volta — **deadlock
silencioso**. Foi o que derrubou a proposta de "reavaliar = decisão de gate que roteia de volta
ao agentTask": elegante, mas o runtime v1 não a honra.

**Decisão do dono (24/07):** proposta expirada na v1 **não tem reavaliação** — a UI shipa só o
estado âmbar com a saída honesta (aprovar indisponível; reprovar roteia sem executar); a ação
de reavaliar inteira vai para a AG-3. A rota `/v1/agents/reproposta` (#36) fica como **fundação
dormente** (cap + auditoria + fato prontos); NÃO é surfaçada na v1.

Duas ações registradas:
1. **Lint de deploy `EXEC_LOOP_WAIT_UNSUPPORTED`** (FEITO nesta PR): recusa laço que contenha
   elemento de espera, com mensagem explícita — recusar o que o runtime não honra (mesmo
   princípio do `EXEC_TOOL_EFFECT_UNGATED`). Teste `loop-wait-lint` cobre os quatro tipos de
   espera + os falsos-positivos (linear, laço só-gateway). Fecha o beco ANTES da AG-4.
2. **[ITEM NOMEADO AG-3 — lote de lib bpmn] Identidade de token fresca por iteração**,
   determinística sob replay (D6), com **fixtures de replay próprias** provando re-entrada em
   espera byte-idêntica. É a correção real que destrava laços (e, com ela, a reavaliação de
   proposta como decisão de gate roteando de volta ao agentTask). Sem isso, laços com espera
   permanecem recusados no deploy.

Documentado como **D37** no dossiê (`docs/compliance/dossie.md`, "Limitações declaradas") e no
runbook da demo (`docs/runbooks/demo.md`) — o cliente não pode descobrir o limite ao vivo.

## 2.18 AUDITORIA DE EVIDÊNCIA (AG-2.2) — itens rebaixados de ✅ para aberto

A auditoria do relatório de fase (`docs/reports/ag2-2.md` §4) cruzou cada critério de aceite
desde a F1 com o artefato de máquina que o prova. O dossiê estava majoritariamente honesto
(cada ✅ cita teste real), mas três padrões viraram **item aberto** — sem retrabalho de trilha,
só honestidade:

1. **[UX] estados vazio/erro/carregando** — o gate "obrigatórios" (CLAUDE.md) é parcial: o leg
   **CARREGANDO não tem teste** em lugar nenhum; **vazio/erro** só em `operate.test.tsx` +
   `tasks.test.tsx` (não em forms/studio). Ação antes da AG-3 (que multiplica telas): asserção
   de loading/`aria-busy` + vazio/erro em forms/studio.
2. **[LGPD] leak-fail de LOG** — o dossiê §05 marcava "teste a criar"; **não existe**.
   `agent-trail-leak.test.ts` cobre a TRILHA do agente, não o redaction de log estruturado.
   A fase-2.md §6 super-afirmou. Ação: criar o teste de leak-fail de log OU manter o item.
3. **[a11y] telas anteriores à AG-2.2** — "axe serious=0" foi afirmado sem máquina de navegador
   e **era falso** (ink-subtle 2,7:1). Corrigido + coberto pelo harness (#39). Fechado; aqui só
   para registro do padrão a não repetir.

Verificados-uma-vez-sem-gate (categoria (b), não bloqueiam, mas não são ✅ de máquina):
restore do banco (manual, `database.md`), p95 do advance (bench reproduzível, não CI-gated),
e2e de navegador do fluxo-alvo (fora do CI — cobertura e2e em CI = testes de contrato). O
**wire-up de um job de CI de navegador** (target-flow + axe) fecharia (b)→(a) para a UI.

## 2.19 AG-2.3 — export de auditoria + verificação de integridade (triagem A–D APROVADA)

Shape aprovado em `docs/handoff/proposta-ag2-3-export.md`; triagem do dono (24/07) dobrada no
código. Entregue: `/v1/audit/export` (normaliza as DUAS trilhas físicas num registro único) +
`/v1/audit/verify` (recompõe o digest, `matches:false` honesto), papel `auditor`.

- **[A] `actor: null` = "ato do motor, sem ator"** — evento puro do engine (sem humano/sistema/
  agente nomeado) grava `null`; não se inventa `{system,engine}`. Documentado no contrato.
- **[B] recibo declara o próprio nível de garantia** — `assurance: "self-recorded"` + nota. A
  âncora v1 é auto-referência verificável (digest+intervalo); notarização externa/WAL imutável é
  **infra do Gate de Piloto** e sobe o valor de `assurance` quando existir. Nada de reivindicar
  "ancorado-verificável" (D30) sem runtime real.
- **[C] recibo no corpo (JSON) / header `X-Audit-Receipt` (CSV)** — e o **evento `audit.export`
  carrega digest + intervalo + filtros** (a trilha é auto-suficiente; o auditor é auditado).
- **[D] papel `auditor` [GATE, migração 0015]** — só leitura de metadados + `audit:export`, ZERO
  escrita; `audit:export` concedida a `admin` e `auditor`. Teste prova 403 em TODA rota de escrita.
- **Decisão de implementação (honesta, reversível):** os meta-eventos `audit.export`/`audit.verify`
  **não entram** no próprio snapshot de export — incluí-los tornaria o digest não-reproduzível (o
  ato de exportar mudaria o resultado). Seguem gravados e consultáveis à parte. É a condição para
  o export provar a si mesmo, não ocultação.

Aceite provado: `audit-export.test.ts` (13) + `audit.e2e.test.ts` (6) + `auth.test.ts` (grants).
**Fora de escopo v1 (nomeado):** paginação por cursor do export de intervalos grandes; ancoragem
externa (infra do piloto); Console de Auditoria como TELA (só API na v1, já era F4/F5).

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
