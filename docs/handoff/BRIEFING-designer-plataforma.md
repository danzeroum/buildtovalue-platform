# Briefing — Parecer de design do Console BuildToValue

> **Para:** Designer oficial da plataforma BuildToValue
> **Assunto:** Situação completa do projeto + protótipos F3 para seu parecer
> **Data:** 2026-07-21
> **O que se espera de você:** um parecer sobre os protótipos revisados
> (`Prototipos_Console_Plataforma_dc__1_.html`) e sobre 3 decisões de design em aberto.
> Seu parecer é o último gate antes de o plano seguir para o desenvolvedor (Claude Code).
> **Documento governante:**
> https://github.com/danzeroum/buildtovalue-platform/blob/main/docs/handoff/PLANO-buildtovalue-platform-v1.2.md

---

## 1. O produto, em três parágrafos

A BuildToValue está construindo um **BPMS completo** (na linha de Camunda / IBM BAW): as
pessoas modelam processos BPMN, publicam versões governadas, e a plataforma **executa**
instâncias desses processos — abrindo tarefas humanas com formulários, chamando integrações,
disparando timers e mantendo auditoria criptográfica de tudo.

O projeto vive em **dois repositórios**. O `danzeroum/bpmn` (público, Apache-2.0) é a
biblioteca: contém o designer BPMN, o viewer, o simulador, a galeria, o motor de execução, o
registry de versões e o ledger de auditoria — **essas superfícies já têm design pronto e NÃO
estão em discussão**. O `danzeroum/buildtovalue-platform` (privado) é o produto SaaS: API
multi-tenant, runtime e o **Console** — uma SPA única com quatro rotas, que é o objeto do seu
parecer.

O desenvolvimento seguirá um plano faseado (v1.2, link acima) já validado por duas rodadas de
revisão externa. A fase que interessa ao design é a **F3 (MVP)**: o primeiro fluxo completo
demonstrável — *modelar → publicar → iniciar instância → tarefa aparece → preencher formulário
→ integração executa → processo encerra → histórico consultável* — executável por uma pessoa
não-desenvolvedora.

## 2. As quatro rotas do Console (escopo F3)

| Rota | Persona | O que faz na v1 |
|---|---|---|
| **/tasks** | Usuário de negócio | Lista de tarefas (minhas / do meu papel / não atribuídas), assumir/liberar, detalhe com formulário, iniciar processo |
| **/forms** | Analista de processos (não técnica) | Criar/editar formulários versionados: lista de campos + propriedades + preview ao vivo (sem drag-and-drop na v1) |
| **/operate** | Operador | Instâncias com posição no diagrama, incidentes (repetir/resolver), jobs/timers, histórico, export XES, cancelar instância |
| **/studio** | Analista/modeladora | O editor BPMN vem PRONTO da biblioteca; o delta da plataforma é só o fluxo de **publicação** (lint + vínculo de formulários por versão) |

## 3. Decisões do plano que moldam o design (não rediscutir — contexto)

Estas decisões foram tomadas com justificativa técnica e já sobreviveram a duas rodadas de
revisão. O design opera DENTRO delas:

- **D3 · Formulário pinado por versão.** Cada tarefa exibe a versão exata do formulário com a
  qual a instância nasceu (`reembolso@v3`), mesmo que já exista uma v4 publicada. O design
  deve tornar isso legível, nunca escondê-lo.
- **D19 · Publicar rejeita, nunca ignora.** O lint roda antes do deploy; elementos BPMN fora
  do escopo v1 (ex.: gateway OR-merge) geram REJEIÇÃO com explicação e o botão de publicar
  fica desabilitado mostrando o motivo. Erro claro > erro silencioso.
- **D20 · Campos sensíveis.** Classificação obrigatória por campo (não pessoal / pessoal /
  sensível). Sensível = cifrado, mascarado por padrão, fora de logs/exports e **não buscável
  por conteúdo** no Operate. O design comunica essas consequências no momento da escolha.
- **D21 · Claim de tarefa é persistente.** Não expira sozinho (ninguém perde um formulário
  longo por "timeout"); liberar/revogar é ação explícita e auditada.
- **D15 · Console único.** Uma SPA, quatro rotas, navegação e identidade compartilhadas.
- **Fora do escopo v1** (não desenhar agora): drag-and-drop no /forms (F4), migração de
  instâncias entre versões (F5), dashboards e filtros avançados do Operate (F4), process
  mining visual (F5), colaboração em tempo real. O plano, seção 12 e Anexo C, lista tudo.

Guardrails de UX do projeto (fonte: *UX no Desenvolvimento de Software*, Paula Azevedo
Macedo): análise heurística de Nielsen registrada nos PRs de interface (G-UX-1); design
centrado nas três personas acima (G-UX-2); protótipo de baixa fidelidade ANTES da
implementação para telas novas de fluxo principal (G-UX-3 — é o que está acontecendo agora);
arquitetura de informação e rotulação consistentes entre rotas (G-UX-4). Gate de
implementação: estados de erro/vazio/carregando obrigatórios e **axe serious = 0**.

## 4. O que já aconteceu com os protótipos (para você não retrabalhar)

O designer da **biblioteca** produziu a primeira versão dos protótipos das telas novas
(somente as superfícies que a biblioteca não cobre). Ela passou por uma revisão de
conformidade com o plano, que aprovou a estrutura e apontou 8 ajustes. A versão que está em
suas mãos (`Prototipos_Console_Plataforma_dc__1_.html`, 6 seções) **já incorpora** essa
revisão:

1. **Tela 05 "Iniciar processo"** adicionada — fecha o fluxo-alvo da F3 (lista só definições
   publicadas, respeita RBAC, business key sugerida/editável, proteção contra clique duplo).
2. **Tela 06 "Estados não-ideais"** adicionada — vazio do primeiro dia (/tasks), busca sem
   resultado (/operate), skeleton de carregamento, erro recuperável com "Tentar novamente".
3. Reordenação de campos (↑↓) no /forms.
4. Classificação renomeada: "público" → **"não pessoal"** (evita implicar visibilidade).
5. Exemplo de campo sensível trocado para "Observações de saúde" (inequívoco), mascarado por
   padrão; "Valor (R$)" deixou de ser sensível.
6. Ações destrutivas/ambíguas ganharam confirmação com motivo auditado ("Reprovar…",
   "Desatribuir…") e a semântica de reprovação foi anotada (conclui com `approved=false`; o
   gateway do processo decide o rumo — reprovar ≠ cancelar).
7. Lint do /studio agora sugere correção no erro de expressão (não só aponta).
8. Filtros rápidos + paginação por cursor no /operate; nota de convenção de expressões no
   /forms; critérios de implementação no rodapé (botões reais, aria-live, piso de ~11px para
   metadados, axe serious = 0).

Ou seja: seu parecer parte de um material já alinhado ao plano. O que buscamos de você é o
olhar de **produto e identidade da plataforma** — não uma re-auditoria de conformidade (essa
já foi feita), embora qualquer problema que você veja seja bem-vindo.

## 5. As 3 decisões em aberto que são SUAS

**A) Rótulos da navegação: rotas literais ou nomes humanos?** Hoje o menu exibe
`/studio /tasks /forms /operate`. A revisão recomendou nomes humanos ("Tarefas · Formulários ·
Operação · Estúdio") por causa da persona de negócio; o designer da biblioteca deixou como
"decisão de produto pendente". É a sua primeira decisão — e ela define o tom do produto
inteiro (ferramenta de operador vs produto de negócio).

**B) Delegação simples entra na F3?** O detalhe da tarefa mostra "Delegar…". O plano prevê a
mecânica (D21) mas lista "delegação avançada" na F4. A recomendação da revisão: incluir na F3
como *reatribuição simples* (escolher uma pessoa, motivo auditado) porque a mecânica de
liberar+assumir já existe; a alternativa é remover o botão da v1. Decida e o plano será
anotado.

**C) Identidade visual do Console.** Os protótipos usam a linguagem do designer da biblioteca
(IBM Plex + Source Serif, paleta creme/verde/dourado). Cabe a você dizer se essa é a
identidade da PLATAFORMA ou se o Console terá direção própria — sabendo que o designer BPMN e
o viewer embutidos virão da biblioteca com o estilo dela, então divergir tem custo de
coerência. Se mantiver, os design tokens viram o `packages/shared-ui` do monorepo.

Há também um item de **spec** (não de design) em que sua opinião é bem-vinda mas a decisão é
técnica: a convenção de expressões nos formulários (`value` = o próprio campo; outras chaves
referenciam outros campos), que será fixada na especificação do pacote `@buildtovalue/forms`.

## 6. Formato do parecer e o que acontece depois

Estruture o parecer em três blocos: (1) **aprovação ou ajustes por tela** (01–06, referenciando
o `data-screen-label`); (2) **as três decisões da seção 5**, com justificativa curta; (3)
**considerações adicionais** livres (fluxos que faltam, microcopy, identidade). Se propuser
mudanças de escopo (nova tela, novo comportamento), sinalize — mudança de escopo passa pelo
plano, não direto para o desenvolvedor.

Com o seu parecer: os ajustes acordados voltam ao protótipo, as decisões A/B/C são anotadas
como adendo do plano v1.2, e o pacote (plano + protótipos + parecer) segue para o Claude Code
iniciar pela F0a. Durante a implementação, você continuará no circuito: os PRs de interface
carregam análise heurística (G-UX-1) e protótipos de telas novas passam por você antes do
código (G-UX-3).

## 7. Artefatos de referência

- **Plano v1.2 (governante):** link no cabeçalho — para o design, importam as seções 1
  (decisões D1–D22), 3 (guardrails G-UX), 5/F3 (escopo das telas), 8 (LGPD que aparece na UI)
  e 12 (fora de escopo).
- **Protótipos revisados:** `Prototipos_Console_Plataforma_dc__1_.html` (6 seções; toggles de
  estado `showServerError` e `lintClean` embutidos).
- **Biblioteca (design existente que o Console embute):** repositório `danzeroum/bpmn` —
  designer, viewer, simulador, galeria.
- **Personas:** usuário de negócio (/tasks), analista não técnica (/forms e /studio),
  operador (/operate).

Bem-vindo ao projeto — o Console é a face do produto, e ele chega às suas mãos com a
engenharia já pactuada para que o design decida o que é do design.
