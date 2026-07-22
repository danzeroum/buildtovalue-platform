# ADENDO-01 ao Plano v1.2 — Consolidação do parecer de design

> **Anexar a:** `docs/handoff/PLANO-buildtovalue-platform-v1.2.md`
> **Data:** 2026-07-21 · **Status:** aprovado — integra o pacote de handoff ao desenvolvedor
> **Fontes:** Parecer do designer da plataforma (`Parecer_Console_BuildToValue_dc.html`) sobre
> os protótipos revisados (`Prototipos_Console_Plataforma_dc__1_.html`, telas 01–06).
>
> O parecer APROVA os protótipos (tela 04 classificada como exemplar). Este adendo registra:
> as três decisões de design que estavam em aberto (agora D23–D25), as mudanças de escopo
> aceitas na F3, os requisitos que sobem para spec/API, e os ajustes que voltam ao protótipo.
> Nenhuma decisão D1–D22 é alterada.

---

## 1. Novas decisões travadas

- **D23 — Navegação com nomes humanos.** Rótulos: **Tarefas · Formulários · Operação ·
  Estúdio** (nessa ordem). As rotas `/tasks /forms /operate /studio` permanecem na URL.
  Sublabel mono discreto (ex.: `Tarefas · /tasks`) é opcional, a critério do design; o rótulo
  primário é humano. Racional: duas das três personas não são técnicas (G-UX-2); rota na
  chrome é vazamento de implementação.
- **D24 — Reatribuição simples entra na F3.** O botão "Delegar…" passa a "**Reatribuir…**".
  Comportamento: escolher UMA pessoa + **motivo obrigatório**, tudo auditado no histórico;
  destinatária deve pertencer ao papel/grupo candidato da tarefa (RBAC). Mecânica = revogar
  claim + atribuir, sobre o que D21 já provê (`claim_token`). **Fora**: cadeias de delegação,
  devolução temporária, regras de ausência — continuam na F4. API: a F3.1 ganha
  `POST /v1/user-tasks/{id}/assignee` (ou equivalente) com `{ assignee, reason }`.
- **D25 — Identidade do Console = linguagem da biblioteca, formalizada em `shared-ui`.**
  IBM Plex Sans/Mono + Source Serif 4; paleta creme/verde/dourado com vermelho único para
  incidente. O pacote `packages/shared-ui` (F1) nasce com quatro requisitos do parecer:
  (1) **tokens por papel semântico** (sucesso/ativo, atenção/aviso, perigo/incidente, escala
  de tinta, superfícies) — o código consome intenção, não hex; (2) **regra do mono**
  (exclusivo para identificadores, versões, telemetria e expressões — nunca decoração);
  (3) **pisos de acessibilidade nos tokens** (metadado ≥ ~11px; contraste AA; status sempre
  por cor + rótulo); (4) **densidade por espaçamento, não por paleta** (superfícies do
  operador densas, do negócio calmas, mesmos tokens).

## 2. Mudanças de escopo aceitas na F3 (o "custo" do parecer)

Três adições de comportamento, todas pequenas, todas dentro do runtime já planejado:

**2.1 Destino pós-início (tela 05).** Após "Iniciar instância", o sucesso leva o usuário à
primeira tarefa (se atribuída/atribuível a ele) ou à instância aberta na Operação.
**Nuance técnica obrigatória:** o avanço é assíncrono (tx → outbox → dispatcher), portanto a
primeira user task NÃO existe no instante da resposta do `POST /v1/instances`. Implementar um
estado intermediário — "instância iniciada, preparando a primeira etapa…" — com
refetch/polling curto que resolve para a tarefa ou, após timeout curto, cai para a visão da
instância. Proibido: redirect síncrono que assume a task criada.

**2.2 Dois estados novos na matriz 06.** (a) **403 / sem permissão de rota** (RBAC v1);
(b) **conflito de claim** — a tarefa foi assumida por outra pessoa entre carregar e clicar
(a API já responde 409 pelo `claim_token`/estado; o design dá voz ao 409: "Esta tarefa acabou
de ser assumida por {pessoa}", com ação de voltar à lista). Ambos entram no gate
erro/vazio/carregando da matriz 3.1.

**2.3 Cancelamento com motivo visível.** "Cancelar instância…" passa a capturar **motivo
obrigatório**; o histórico e o cabeçalho da instância terminal exibem "cancelada por {usuário}
· {motivo}". API: `POST /v1/instances/{id}/cancellation` aceita `{ reason }`; o motivo entra
em `history_events` (fecha o ciclo de auditoria apontado no parecer).

## 3. Requisito de API decorrente de D20 (não é só UI)

A máscara de campos sensíveis na aba **Variáveis** da Operação (ajuste bloqueante da tela 03)
tem par obrigatório no servidor: `GET /v1/instances/{id}/variables` devolve valores de campos
`sensitive` **mascarados por padrão**; revelação exige permissão explícita (RBAC) e gera
evento de auditoria. Sem isso, a API é a porta lateral que a UI fechou. Vale para qualquer
endpoint que retorne variáveis (incluindo payload de user task para quem não é o responsável).

## 4. Itens que sobem para a spec de `@buildtovalue/forms` (F0b.5)

O parecer APOIA a convenção de expressões e acrescenta três requisitos, todos aceitos:
1. `value` = o próprio campo; outras chaves referenciam outros campos (já previsto — fixar).
2. **`value` é palavra reservada**: não pode ser usada como chave de campo (validar no editor
   e no schema).
3. Requisitos do editor (F3.3): legenda da convenção sempre inline ao lado de inputs S-FEEL;
   **autocomplete das chaves disponíveis** para evitar erro de digitação.

## 5. Ajustes de design que voltam ao protótipo (sem mudança de plano)

Tela 01: micro-affordance "por que v3?" no badge do formulário pinado ("esta instância nasceu
na v3"); controle de ordenação exposto (mais antigas / por prazo); tag "PESSOAL" para ≥11px.
Tela 02: caixa de consequências de "sensível" **amarrada à seleção** — surge/intensifica ao
escolher "sensível", listando cifrado · mascarado · fora de logs/exports · não buscável
(comunicação no momento da escolha, D20). Tela 03: máscara na aba Variáveis (par de API na
seção 3); p95/telemetria de engine movida para bloco "saúde do sistema", strip principal fica
com o acionável (incidentes, jobs atrasados, timers); micro-confirmação em "Repetir"
explicitando o que será reexecutado (job com efeito externo). Tela 04: anotar o ponto de
entrada a partir do designer da biblioteca. Tela 06: voz do erro por persona — negócio recebe
"Não foi possível carregar suas tarefas" com detalhe técnico (problem+json) recolhível;
operador vê o técnico direto. IA transversal: desambiguar "**Publicar formulário**" (/forms)
× "**Publicar definição**" (/studio) — mesmo verbo, objetos explícitos.

## 6. Efeito no plano

- **F1** (`shared-ui`): incorpora os 4 requisitos de tokens do D25.
- **F3.1** (API): + reatribuição (D24), + cancelamento com motivo (2.3), + máscara de
  sensíveis em variáveis com revelação auditada (3).
- **F3.3** (/forms): + `value` reservada, legenda inline, autocomplete (4).
- **F3.4** (/tasks): + Reatribuir…, + destino pós-início com estado intermediário (2.1),
  + estados 403/conflito de claim (2.2).
- **F3.5** (/operate): + bloco saúde do sistema, + confirmação de Repetir, + terminal
  "cancelada por X · motivo Y".
- **F4** (inalterada, com fronteira mais nítida): delegação temporária/cadeias/ausência.
- **Matriz 3.1 / gate de UX**: 403 e conflito de claim passam a compor "estados não-ideais
  obrigatórios".
- Esforço estimado do adendo: pequeno (nenhum novo subsistema; tudo opera sobre runtime,
  RBAC e auditoria já planejados).

## 7. Processo (confirmado)

O designer da plataforma segue no circuito: análise heurística nos PRs de interface (G-UX-1)
e protótipos de telas novas de fluxo principal passam por ele antes do código (G-UX-3).
Pacote de handoff ao desenvolvedor: PLANO v1.2 + este ADENDO-01 + protótipos revisados +
parecer. O protótipo recebe os ajustes da seção 5 em paralelo ao início da F0a — não bloqueia
o kick-off (as telas só são implementadas na F3).
