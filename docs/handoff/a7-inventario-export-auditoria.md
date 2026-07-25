# A7 — Inventário do export de auditoria para marcação do designer

> **Par de:** `docs/handoff/ADENDO-04-administracao.md` §"A7 export de auditoria" (recorte
> fechado) e o protótipo já existente (`Prototipos Administracao.dc.html`, seção "A7 · EXPORT
> DE AUDITORIA", linhas 488–592). **Rito:** rótulo, voz e tratamento são do design; `kind`/
> rota/RBAC são contrato do dev. Sem código.
>
> Diferença deste inventário para os anteriores (AG-3.2/AG-3.3): aqui já existe um protótipo
> visual aprovado. O que falta não é desenhar do zero — é **confrontar o protótipo com o dado
> real** da API (que já existe desde a AG-2.3) e apontar onde os dois divergem, porque um
> protótipo é uma imagem estática e não podia prever o shape exato nem os estados não-ideais.

## 0 · Estado hoje

- `GET /v1/audit/export` e `POST /v1/audit/verify` existem e estão testados (`apps/api/src/routes/audit.ts`, 13 testes em `packages/db/tests/audit-export.test.ts`). RBAC `audit:export` (admin + auditor).
- **A lacuna que bloqueava o botão já foi corrigida** (PR #62, mergeada nesta sessão): `audit:export` e o papel `auditor` agora existem em `apps/console/src/capabilities.ts`/`session.ts`, espelhados byte-a-byte do servidor, com teste de paridade que fecha a classe do bug.
- Nenhuma tela consome a rota hoje — `apps/console/src/routes/` não tem `audit.tsx`; nav (`shell.tsx`) não tem entrada de Administração/Auditoria ainda (só `/tasks /forms /operate /studio`).
- **Não é o Console de Auditoria (E3/F4)** — isso está fora de escopo v1 (`CLAUDE.md`: "Console de Auditoria como tela (só API na v1)"). A7 é a alavanca mínima: filtros → export → recibo → verificar.

## 1 · O protótipo já aprovado (o que ele mostra)

Nav lateral "Administração" com item "Auditoria" selecionado. Corpo: grade de 4 filtros (Período, Formato, Ator, Tipo de evento) → botão "Exportar com recibo" → seção "Verificar integridade" (arrastar arquivo OU informar `export_id`). Coluna direita: cartão escuro do recibo (`export_id`, período, eventos, resumo sha256, "ancorado · bloco #4903 · 14:22:10", solicitado por) + botões "Baixar arquivo"/"Copiar recibo" + checklist "O que o auditor confere".

## 2 · Onde o protótipo divergia do dado real — DECISÕES DO DONO (fecham a 4ª rodada do mesmo rito: "o protótipo promete mais que o sistema tem", depois de P1/kill-switch/timeline)

**A — recibo: CORRIGIR para a garantia real (não é opcional, é requisito de conteúdo).**
O cartão do recibo passa a mostrar `assurance: 'self-recorded'` com a nota legível ("digest
registrado na própria trilha; sem notarização externa"), o `anchorRef` real (digest +
intervalo, nas DUAS trilhas separadas tenant/instância) e a **contagem de linhas
não-ancoradas** (`unanchoredCount`). **Nunca "bloco #N" sequencial — não existe.** Gatilho
nomeado para o futuro: quando a ancoragem externa existir (WAL imutável, infra do Gate de
Piloto), o campo de garantia vira `'externally-anchored'` e o cartão muda de novo — não
antes. Registrado em `docs/pendencias.md` (ver §2.28).

**B — verificar: SEM lookup por `export_id`.** A tela oferece só o fluxo real: colar/carregar
o recibo completo (digest+filtros) e verificar contra o export. Nada de "informe o id" — não
existe rota que o resolva.

**C — as três menores, JÁ FECHADAS, entram direto (não pedem nova marcação):**
- **Ator = DOIS campos** (`actorType` dropdown + `actorId` texto) — mantém a consistência do envelope `{type,id}` do resto do produto, em vez de um "Ator: todos ▾" único.
- **`resourceType`/`resourceId` SIM na v1** — a rota já os devolve; é filtro útil ao auditor e não custa nada a mais.
- **`generatedBy` via `ActorBadge`** — mesma linguagem da timeline (AG-3.3); o export foi gerado por alguém e o auditor quer ver quem, não um texto solto misturando papel com nome de permissão.

**D — `export_id` (identificador) não existe — nem para exibir, nem para buscar depois.** O
"id" visível, se houver algum, é o `digest` (truncado) — não um ponteiro recuperável.

**E — "Período: últimos 30 dias ▾"** continua sendo preset de UI (a API só aceita `from`/`to`
ISO exatos) — tradução preset→datas é implementação, não pede marcação.

## 3 · Campos reais (exemplos de teste, `packages/db/tests/audit-export.test.ts`)

Recibo (JSON, `receipt`):
```json
{
  "digest": "sha256:9f2c…(64 hex)",
  "algorithm": "sha256",
  "count": 3412,
  "filters": { "from": "2026-06-24T00:00:00.000Z", "to": "2026-07-24T14:22:10.000Z", "source": "both" },
  "anchorRef": "sha256:9f2c…;from=2026-06-24T00:00:00.000Z;to=2026-07-24T14:22:10.000Z",
  "assurance": "self-recorded",
  "assuranceNote": "Digest e âncora gravados pela própria plataforma no evento audit.export; ainda não há notarização externa/WAL imutável (infra do Gate de Piloto).",
  "coverage": {
    "perTrail": {
      "tenant": { "throughXid": "…", "throughTime": "2026-07-24T14:20:00.000Z" },
      "instance": { "throughXid": null, "throughTime": null }
    },
    "unanchoredCount": 0,
    "note": "todas as linhas deste export estão dentro da cobertura ancorada"
  },
  "generatedAt": "2026-07-24T14:22:10.000Z",
  "generatedBy": { "type": "user", "id": "dpo@acme", "requestId": "req-77" }
}
```
Um `record` (cada linha da trilha exportada): `{ source: 'instance'|'tenant', at, actor: {type,id,requestId}|null, eventType, resourceType, resourceId, motivo, seq, anchorRef }` — `actor:null` = ato do motor (honesto, D6), não "desconhecido".

Verify: `{ matches: boolean, expectedDigest, actualDigest, count, anchorRef }` — `matches:false` é **200**, resultado honesto (a trilha mudou desde o export), não erro.

## 4 · Estados não-ideais (o protótipo é uma imagem parada — não cobre nenhum destes)

- **Exportação vazia**: filtros que não casam nada → `count:0`, `records:[]`, recibo válido do mesmo jeito (não é erro, é "zero eventos neste recorte" — honesto, não confundir com falha).
- **Carregando** durante o export (pode levar tempo com muitos registros).
- **Falha** (rede, 5xx) — nunca virar silêncio nem "0 eventos".
- **`matches:false` no verify** — precisa de voz PRÓPRIA (âmbar/atenção, não vermelho de erro): "a trilha mudou desde este export" é informação, não falha do sistema.
- **CSV vs JSON**: o recibo do CSV vem no header, não no corpo — a tela precisa mostrá-lo do mesmo jeito (a fonte muda, a apresentação não deveria).

## 5 · Perguntas abertas para a marcação (rótulo, voz, tratamento visual — do design)

1. **Voz do cartão do recibo corrigido** (decisão A do §2): como nomear/desenhar `assurance`/`assuranceNote` (mesma família do `EvidenceSeal` — reusar o estado `ancoravel` com nota "self-recorded", ou tratamento próprio da tela?), como apresentar as duas trilhas (tenant/instância) + `unanchoredCount` sem virar uma lista técnica ilegível.
2. **Voz do fluxo de verificar sem lookup por id** (decisão B do §2): colar o JSON do recibo (textarea), fazer upload do arquivo exportado (o client extrai digest+filters), ou os dois?
3. Onde a tela mora na navegação — precisa de uma seção "Administração" nova no `shell.tsx` (hoje só tasks/forms/operate/studio), visível a quem tem `audit:export` (admin + auditor)?

## 6 · Notas de sequência para o dev

- Nenhum pré-requisito de backend falta — rota + RBAC já prontos e testados (AG-2.3); `audit:export`/papel `auditor` já espelhados no console (PR #62).
- `payload`/response da API já tipado no SDK gerado (`auditExportResponseSchema`/`auditVerifyResponseSchema` via zod) — sem cast freeform como no histórico.
- Nav precisa de uma entrada nova (hoje não existe "Administração" no `shell.tsx`) — escopo de UI, não de rota.
- Sem migração, sem rota nova, sem mudança de RBAC.
