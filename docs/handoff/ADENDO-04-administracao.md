# ADENDO-04 ao Plano v1.2 — Superfície de Administração e reordenamento da AG-3

> **Anexar a:** `docs/handoff/PLANO-buildtovalue-platform-v1.2.md` (após o ADENDO-03)
> **Data:** 2026-07-24 · **Status:** aprovado pelo dono → segue ao desenvolvedor
> **Fontes:** auditoria de lacunas administrativas (parecer do designer, verificada no
> código `main @ c556fdc`); protótipos A1–A7 (`Prototipos-Administracao`); ADENDO-02
> (P4/P5 aprovados como v1) e ADENDO-03 (audit export).
>
> **Por que existe:** a auditoria feita contra o código real — não contra os protótipos —
> revelou que três capacidades aprovadas no ADENDO-02 como "v1 completa" (inteligência do
> tenant, kill-switch, catálogo de tools) **existem como funções de pacote mas não têm
> rota HTTP nem tela**; são operadas hoje por `INSERT` manual no banco. O kill-switch nesse
> estado é um controle de laboratório, não de produto — e é a interrupção do Art. 14 do
> EU AI Act e o item 8 do Gate de Piloto. Este adendo cria a superfície que faltava e
> reordena a AG-3 por conformidade. Nenhuma decisão D1–D31 muda.

---

## 1. O achado (verificado, não presumido)

Confirmado por busca em `apps/api/src`: `setKillSwitch`, `tenantAiConfig` e `tenantTools`
não aparecem em nenhuma rota HTTP. O console tem exatamente quatro rotas
(`tasks`/`forms`/`operate`/`studio`) e nenhuma administrativa. `audit:export` (rota
existente desde a AG-2.3) **não está** no espelho `capabilities.ts` do console — a UI não
renderizaria o botão nem se quisesse. Administração básica de SaaS (papéis, desativar
acesso, trocar senha, recuperação) inexiste: usuários nascem só via `seed-demo.ts` e
`/v1/me` é somente leitura.

## 2. Decisão nova

- **D32 — Superfície de Administração é parte da v1.** Uma 5ª rota `/admin` no console,
  visível apenas a papéis administrativos, expõe as alavancas dos mecanismos que já
  existem no runtime. A regra que orienta todo o adendo: **mecanismo sem alavanca acessível
  ao operador do tenant não conta como capacidade de produto** — vale em especial para
  controles de conformidade (kill-switch, desativar acesso), onde "operável só por quem tem
  o banco" é uma lacuna de segurança, não um detalhe de UX.

## 3. Reordenamento da AG-3 (conformidade primeiro)

A ordem anterior (AG-3.0 → P1 → P2 → P4/P7 → P5/P6 → P3) colocava P4 no meio. **P4 sobe.**
Nova ordem:

| Fase | Superfície | Justificativa da posição |
|---|---|---|
| AG-3.0 ✅ | fundação shared-ui | concluída |
| AG-3.1 (em curso) | **P1 gate** | maior aposta de produto; já iniciada |
| **AG-3.2 (novo lugar)** | **P4 Inteligência + kill-switch (A2)** + **A1 identidade** | **conformidade: a alavanca do Art. 14 / item 8 do gate** |
| AG-3.3 | **P2 Operate** (timeline) + custo real no drill-down | destrava com a fiação do provider |
| AG-3.4 | **P5/A3 tools** + **A7 export de auditoria** | A7 é a alavanca da AG-2.3 (audit:export) |
| AG-3.5 | **admin básica (A4/A5/A6-A)** | higiene de SaaS — ver §5 |
| AG-3.6 | **P6 deploy+lint** + **P7 Evidence Bundle** + **P3 squad leitura** | mais mecânicas; combináveis |

A **AG-3.1 não para** — é a primeira superfície e segue com G-UX-3 antes do merge.

## 4. As alavancas de conformidade (crítico — AG-3.2 e AG-3.4)

- **Kill-switch (A2):** rota HTTP nova + botão, acionável por **papel de admin do tenant**,
  com a confirmação que nomeia o efeito ("em execução fazem parada honesta · nenhum novo
  inicia · gates humanos seguem · reversível"), **motivo obrigatório**, e o estado ativo
  mostrando quem pausou e por quê. O mecanismo (`setKillSwitch` com auditoria, retomada
  §5.2) **já existe e é testado** — este adendo autoriza apenas a rota e a alavanca.
- **Config de inteligência do tenant (A2/A1):** rota para ler/gravar provider/model/
  base_url/key_ref (chave só `secret://`, nunca em claro — D29 intacto) e o câmbio
  USD→BRL, hoje congelado em `FX_USD_BRL` por env, vira config por tenant.
- **Catálogo de tools (A3):** rota de habilitar/desabilitar por tenant, auditado; efeito e
  autorização em leitura (do contrato); a invariante D31 (irreversível nunca "automática")
  visível.
- **Export de auditoria (A7):** `audit:export` entra no `capabilities.ts` do console + a
  tela mínima (filtros + recibo de ancoragem). Não é o Console de Auditoria E3 (F4) — é a
  alavanca da rota que a AG-2.3 já construiu.

## 5. Administração básica (AG-3.5 — recorte fechado)

- **Entra na v1:** mudar papel, **desativar acesso**, redefinir senha (A4, painel de
  gerenciar); trocar a própria senha + preferências incl. fuso horário (A5); recuperação
  **variante A** — senha temporária emitida pelo admin, exibida **uma única vez**,
  não recuperável, com o ato na trilha e a senha fora dela (A6-A).
- **Fica para F4:** **criar/convidar** pessoa nova (A4 "+ Adicionar pessoa" ausente/
  desabilitado na v1 — só vira gargalo no segundo cliente); recuperação **autoatendimento**
  (A6-B) — depende de e-mail transacional, dependência de infra.
- **Racional do corte:** desativar acesso é a mesma classe do kill-switch — sem a alavanca,
  cortar quem saiu da empresa exige `UPDATE` no banco. É segurança, não conveniência; por
  isso entra. Criar usuário é conveniência de escala; por isso espera. **Se cortar, corta a
  criação, nunca a desativação.**

## 6. Regime e contrato

Todas as rotas novas (kill-switch, config de inteligência, tools, audit export, gestão de
membros/papéis, senha/perfil, senha temporária) **exigem proposta de shape para aprovação
do dono antes de implementar** — mesma mecânica da PR #9 e das AG-2.x. RBAC novo (papel de
admin do tenant e suas permissões) é **gate**. As superfícies passam pelo circuito de
design: P4/P5 e A7 já estão prototipados (A1–A3, A7); a marcação de A4/A5/A6 pelo designer
sai depois deste adendo (o recorte estava indefinido até aqui). G-UX-3 nas telas de maior
aposta; axe serious = 0 em todas (o harness #39 já existe).

## 7. Gate de Piloto — efeito

O item 8 (kill-switch ensaiado com evidência) passa a ter **alavanca de produto** para ser
ensaiado — antes deste adendo, "ensaiar o kill-switch" significava `INSERT` no banco, o que
não demonstra o controle que o cliente teria. O item 12 (export com recibo verificado)
ganha a alavanca de UI. Nenhum item novo é criado; dois deles passam de "mecanismo existe"
para "operável como o cliente operaria".

## 8. Aceites nomeados

1. Kill-switch acionável pela UI por papel de admin, com motivo obrigatório e efeito
   nomeado; evento auditado; e a retomada §5.2 acessível pela mesma superfície.
2. Desativar acesso pela UI corta o login do usuário sem apagar a trilha (teste: usuário
   desativado recebe 401/403; trilha permanece consultável).
3. `audit:export` no capabilities do console + export pela UI com recibo de ancoragem.
4. Senha temporária exibida uma vez, não recuperável, ato na trilha (teste: o valor não
   aparece em nenhuma leitura posterior nem em log — estende o leak-fail).
5. Config de inteligência gravada pela UI com chave só `secret://` (nunca em claro na
   resposta nem em log).
6. "+ Adicionar pessoa" ausente/desabilitado na v1 com o motivo à vista (F4 nomeado).
7. G-UX-3 nas telas de maior aposta + axe serious = 0 em todas as novas.
