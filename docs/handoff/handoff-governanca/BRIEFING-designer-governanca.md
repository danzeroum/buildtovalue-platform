# Briefing — Atlas de Governança da Plataforma BuildToValue

> **Para:** Designer oficial da plataforma BuildToValue
> **Assunto:** Novo artefato — o "Atlas de Governança": todos os mecanismos de governança
> da plataforma mapeados por camada (banco, runtime, APIs, logs, ledger, frontend), com
> protótipos das superfícies visíveis e uma linguagem visual de evidência unificada.
> **Data:** 2026-07-22
> **Contexto normativo:** maximizar conformidade com ISO/IEC 42001 e EU AI Act. O
> ADENDO-03 (anexo) fechou as lacunas de engenharia; este briefing encomenda a camada
> que transforma engenharia em EVIDÊNCIA LEGÍVEL — para auditores, para o DPO do cliente
> e para a venda. Como sempre: o inventário abaixo é meu; sua análise e suas propostas
> têm o mesmo peso das encomendas.

---

## 1. O que é o Atlas (o entregável principal)

Um documento visual — no idioma da plataforma, imprimível como os pareceres — que
responde à pergunta de um auditor em qualquer camada: *"mostre-me a evidência de que
este controle existe e funciona"*. Para cada mecanismo: **o que é → onde vive (camada) →
que evidência produz → onde a evidência aparece (superfície ou consulta) → que
controle/artigo atende** (ISO 42001; EU AI Act Art. 12 registros / 13 transparência /
14 supervisão e interrupção). O Atlas é irmão visual do `docs/compliance/dossie.md`
(D37): o dossiê é a matriz técnica; o Atlas é a versão que se apresenta numa auditoria
ou numa reunião de venda.

## 2. O inventário por camada (verifique, complete, corrija)

**Banco de dados:** RLS + FORCE em todas as tabelas (isolamento provável por consulta
aos policies); trilhas **append-only por permissão** (migração 0006 — D32): auditor vê o
dump dos grants e um UPDATE negado; definições de processo/formulário **imutáveis**
(0004); idempotência com replay; cifra de campos `sensitive` (KeyProvider D20) com
`classification` persistida; salt por registro (ADR-0002).

**Runtime:** exatamente-uma-vez (`effect_key` D11) e fencing (`lock_token` D12,
`claim_token` D21, mundo obsoleto D28); trilha de fatos do agente (D27) com origem
rotulada e `evidência-verificada` exclusiva do runtime real (D30); paradas honestas;
enforcement de budget; invariante de tools irreversíveis (D31); StateMigrator com
versões gravadas por instância.

**Ledger e integridade:** cadeia hash com tombstones LGPD e "nunca conteúdo pessoal"
(teste nomeado); ancoragem de deploys e de Evidence Bundles; **ancoragem periódica de
digest das trilhas** (D35); exports com recibo verificável; anchors externos
(S3/RFC3161) opcionais.

**APIs:** toda ação sensível exige e audita motivo (reveal, cancellation, resolution,
reassignment, kill-switch); `GET /v1/audit/export` com filtros (D36); XES/IEEE 1849 por
instância; cross-tenant = 404 sempre; problem+json com tipos estáveis.

**Logs e observabilidade:** redaction leak-fail (teste que falha se sensível vazar);
bindings `tenant_id` + `user_id` (D34); negações de autorização em log estruturado +
métrica, persistidas só para recursos de alta sensibilidade; métricas de runtime e
alertas.

**Trilhas de auditoria:** `history_events` (ancorada em instância, `seq` determinístico)
e `tenant_audit_events` (governança sem instância: kill-switch, tools, config, exports,
auth relevante — D33), ambas com **envelope padronizado de ator**
(`user | system | agent`).

**Frontend (o que os protótipos existentes JÁ mostram):** classificação obrigatória com
consequências no momento da escolha (tela 02); reveal com motivo; confirmações auditadas
(cancelar, reprovar, kill-switch); gate de agente com escopo exato e world-delta (P1);
Evidence Bundle com selo de ancoragem (P7); lint de rejeição explicada (04/P6);
"cancelada por X · motivo Y" no histórico.

## 3. O que desenhar (encomendas)

**E1 · O Atlas em si** — o documento da §1, organizado por camada ou por jornada de
auditoria (sua escolha; justifique). Deve funcionar impresso e em tela.

**E2 · Linguagem visual de evidência unificada** — hoje os sinais de governança estão
espalhados (selo de ancoragem no P7, chips de efeito, aviso de sensível, motivo
auditado). Falta o sistema: um vocabulário único para "isto é auditado" / "isto está
ancorado e verificável" / "isto está mascarado" / "quem agiu: humano · sistema · agente"
(o envelope de ator do D33 merece um badge tríplice consistente). Entra no `shared-ui`
como tokens+componentes; vale retrofit leve nas telas existentes onde o sinal ficou
ad-hoc.

**E3 · Protótipo do Console de Auditoria (F4, desenhado agora como norte)** — a
superfície que o auditor/DPO usa: trilha unificada filtrada (ator, período, tipo,
recurso), detalhe de evento com envelope completo, botão "verificar integridade" que
recalcula e mostra o digest ancorado, e o fluxo de export com recibo. Na v1 só a API
existe; o protótipo agora garante que a API nasce com os campos que a tela vai precisar.

**E4 · Fluxo de export com recibo (v1)** — mesmo sem console, alguém vai exportar via
API e receber um recibo de ancoragem: desenhe o formato do recibo (o que um auditor
confere) e onde o recibo aparece (resposta da API documentada / e-mail? sua proposta).

**E5 · Padrões de negação e de retenção** — como uma negação de acesso se apresenta
(sem vazar existência cross-tenant: 404; intra-tenant: a voz do 403 por persona, que
você já definiu na F3) e como superfícies indicam retenção/expurgo quando existirem
(F5 — só o padrão, não as telas).

**E6 · A página de venda da governança** — uma prancha (estilo "Assinaturas de
inovação" dos seus protótipos) contando a história: *modelou → publicou com lint →
executou com humano no gate → cada ato com ator e motivo → tudo ancorado e exportável*.
É o Atlas condensado em um argumento.

## 4. Personas (duas novas)

Às três existentes somam-se: **auditor externo** (não conhece o produto; precisa achar
evidência em minutos; lê o Atlas antes de tocar na tela) e **DPO/compliance do cliente**
(recorrente; quer filtros, exports e a prova de integridade sem pedir ajuda). O Console
de Auditoria (E3) serve aos dois; o Atlas (E1) é o mapa de ambos.

## 5. Princípios vinculantes (herdados, valem aqui com força total)

Evidência nunca é conteúdo (o Atlas mostra provas com dados mascarados — jamais um
exemplo com dado pessoal legível); `evidência-verificada` só do runtime real (D30);
ledger nunca contém conteúdo pessoal (o Atlas deve DIZER isso — é diferencial); ator
sempre nomeado nos três tipos; parada honesta não é erro; sinais nunca só por cor;
axe serious = 0 nas superfícies novas quando implementadas.

## 6. Formato e processo

Mesmo rito que funcionou três vezes: protótipos + parecer em três blocos (por encomenda
E1–E6; decisões suas com justificativa; propostas adicionais), sinalizando **ESCOPO**
o que muda comportamento (passa pelo plano — ex.: se o E4 pedir campo novo no recibo,
vira item da proposta de contrato AG-2). Referências: ADENDO-03 (as decisões D32–D37 e
as rejeições — não desenhe triggers, hash-por-linha nem assinatura própria: foram
rejeitados com justificativa), ADENDO-02, protótipos Console + P1–P7, ADR-0002,
`docs/reports/fase-2.md` e migrações 0001–0005 no repo (público nesta etapa). Com seu
parecer: consolido, o dono aprova, e o pacote segue ao desenvolvedor junto da leva de
conformidade.

Uma provocação final, no espírito das suas melhores entregas: concorrentes tratam
conformidade como PDF anexo; nós temos a chance de tratá-la como **superfície de
produto** — a mesma plataforma que executa o processo exibe a prova. Se houver uma
"assinatura visual" para isso (como o dial de autonomia virou assinatura dos agentes),
ela nasce neste Atlas.
