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

## 2 · Onde o protótipo diverge do dado real (achados do dev — decisão do design, não do dev)

**2.1 — `export_id` não existe.** O recibo real (`auditReceiptSchema`) não tem esse campo — nem a rota gera um identificador de export. Não há `GET /v1/audit/exports/:id` para buscar por ele depois. O protótipo mostra `exp_2026-07-24_a91f` como se fosse recuperável mais tarde; hoje não é. Opções reais: (a) o "id" visível é o `digest` truncado (o único identificador estável que existe), (b) não mostrar um "id" — o recibo inteiro (JSON) é a prova, não um ponteiro para ela.

**2.2 — a ancoragem NÃO é "bloco #4903 · 14:22:10".** Isso implica notarização externa (blockchain/bloco sequencial) que o sistema não tem. O real é `anchorRef` = uma string **self-recorded** (`{digest};from=...;to=...`) — o mesmo desenho que o `EvidenceSeal` (shared-ui) já expõe como estado `ancoravel`, com a nota obrigatória "self-recorded", **nunca "verificado"** (D30). Além disso a cobertura de ancoragem é **em DUAS trilhas separadas** (`coverage.perTrail.tenant` e `.instance`, cada uma com `throughXid`/`throughTime` PRÓPRIOS) + `unanchoredCount` (quantas linhas deste export ainda não estão dentro da fronteira ancorada) + uma `note` textual. Exemplo real (`packages/db/src/audit/export.ts:344-346`): `"todas as linhas deste export estão dentro da cobertura ancorada"` ou `"3 linha(s) deste export ainda NÃO ancorada(s) (além da fronteira de digest)"`.

**2.3 — `assurance`/`assuranceNote` estão AUSENTES do cartão do protótipo — é o achado mais importante.** O recibo real sempre carrega `assurance: 'self-recorded'` + a nota literal: *"Digest e âncora gravados pela própria plataforma no evento `audit.export`; ainda não há notarização externa/WAL imutável (infra do Gate de Piloto)."* O cartão escuro do protótipo, do jeito que está desenhado (visual de cofre/prova), **sugere uma garantia que o sistema explicitamente não tem** — a mesma família de "nunca fingir" que já corrigiu o P1, o kill-switch e a timeline. Sem esse aviso, o cartão superprometeria.

**2.4 — verificar por `export_id` não é possível.** Não existe lookup por id — `POST /v1/audit/verify` pede `expectedDigest` + `filters` (os dois vêm de dentro do recibo que a exportação devolveu, seja no corpo JSON, seja no header `X-Audit-Receipt` do CSV). O fluxo real é "cole/envie o recibo que você já tem", não "digite um id e eu busco".

**2.5 — "Ator: todos ▾"** — a API tem DOIS filtros distintos: `actorType` (enum `user|system|agent`) e `actorId` (texto livre, um id específico). O protótipo não distingue os dois. Precisa de marcação: um campo só (com `actorType` como dropdown) ou dois?

**2.6 — filtros que a grade do protótipo não mostra**: `resourceType`/`resourceId` existem na API (ex. filtrar só eventos de uma instância específica) mas não aparecem nos 4 campos desenhados. Adicionar agora ou deixar de fora da v1 (arquivo/CSV já traz tudo, filtro é só conveniência)?

**2.7 — "solicitado por: DPO · audit:export"** — o dado real é `generatedBy: {type,id,requestId}` (o mesmo envelope D33 do resto do produto). O protótipo mistura um papel (DPO) com o nome de uma permissão (`audit:export`) num texto só — provavelmente renderiza melhor como `ActorBadge` (shared-ui), consistente com a timeline (AG-3.3) e o P1.

**2.8 — "Período: últimos 30 dias ▾"** é preset; a API só aceita `from`/`to` ISO exatos. Tradução preset→datas é implementação, não pede marcação — só registro de que os presets (30 dias, 7 dias, etc.) são invenção da tela, não da API.

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

## 5 · Perguntas abertas para a marcação

1. §2.1–2.3 resolvidas pela marcação: como o cartão do recibo representa `assurance`/`assuranceNote` (achado mais importante — sem isso o cartão superpromete) e a cobertura em duas trilhas + `unanchoredCount` (sem inventar "bloco #NNNN").
2. §2.4: como fica a UI de "verificar" sem lookup por id — upload do arquivo exportado (client extrai digest+filters do JSON) e/ou colar o recibo?
3. §2.5: `actorType` (dropdown) e `actorId` (texto) — um campo ou dois?
4. §2.6: incluir `resourceType`/`resourceId` na v1 ou deixar de fora?
5. §2.7: ator (`generatedBy`) via `ActorBadge` (consistente com a timeline) ou texto próprio desta tela?
6. Onde a tela mora na navegação — precisa de uma seção "Administração" nova no `shell.tsx` (hoje só tasks/forms/operate/studio), visível a quem tem `audit:export` (admin + auditor)?

## 6 · Notas de sequência para o dev

- Nenhum pré-requisito de backend falta — rota + RBAC já prontos e testados (AG-2.3); `audit:export`/papel `auditor` já espelhados no console (PR #62).
- `payload`/response da API já tipado no SDK gerado (`auditExportResponseSchema`/`auditVerifyResponseSchema` via zod) — sem cast freeform como no histórico.
- Nav precisa de uma entrada nova (hoje não existe "Administração" no `shell.tsx`) — escopo de UI, não de rota.
- Sem migração, sem rota nova, sem mudança de RBAC.
