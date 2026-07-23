# Handoff — Atlas de Governança (conformidade ISO/IEC 42001 · EU AI Act)

Pacote de design da camada de governança. Entra em `docs/handoff/` junto do ADENDO-03.
Não cria controle novo: torna legível o que a engenharia (ADENDO-03, D32–D37) já impõe.

## Conteúdo

| Arquivo | O que é |
|---|---|
| `ADENDO-03-conformidade.md` | **Governante.** D32–D37, sequenciamento, rejeições do Anexo C (12–15), 6 aceites, itens novos do Gate de Piloto. Anexa ao PLANO após o ADENDO-02. |
| `BRIEFING-designer-governanca.md` | O briefing que encomendou o Atlas: inventário por camada, encomendas E1–E6, personas (auditor externo, DPO), princípios. |
| `Atlas-de-Governanca.dc.html` | **E1** (imprimível). Sete camadas × (mecanismo → evidência → onde aparece → controle/artigo ISO 42001 / AI Act 12·13·14), atalho por jornada, **E4** recibo de export, **E5** negação/retenção. |
| `Prototipos-Governanca-E2-E3-E6.dc.html` | **E2** linguagem de evidência (selo de procedência) · **E3** Console de Auditoria (norte F4) · **E6** prancha de venda. |
| `Parecer-Governanca.dc.html` | Parecer em três blocos: por encomenda E1–E6, decisões justificadas, propostas adicionais. |
| `support.js`, `doc-page.js` | Runtime dos `.dc.html` (não editar). |

## Como abrir
Abra os `.dc.html` no navegador — carregam `./support.js` (e os pareceres/Atlas também `./doc-page.js`) do mesmo diretório. Mantenha os arquivos juntos. Atlas e pareceres exportam PDF pelo diálogo de impressão.

## A assinatura visual
**Selo de procedência** = ator (humano · sistema · agente, envelope D33) + estado de evidência (auditado · ancorado-verificável · mascarado · negado). Ícone+rótulo, nunca só cor. Vai para `packages/shared-ui`; retrofit leve nas telas existentes (selo do P7, chip de efeito, aviso de sensível passam a falar este vocabulário).

## Insumo direto para a proposta de contrato da AG-2
A v1 deve **gravar já** (ou a F4 vira migração retroativa de trilha imutável):
- envelope `actor{type,id,requestId}` **consultável** (não em payload);
- `event_type` / `resource_type` / `resource_id` estáveis (publicar catálogo de event_types no contrato);
- `motivo`;
- **referência de ancoragem recuperável por evento/intervalo** (sem ela o "verificar integridade" da F4 não tem o que mostrar).
Rotas: `GET /v1/audit/export` (D36) · `POST verificar integridade` (resultado + bloco, ela própria auditada). Migração 0006 (D32/D33) no mesmo pacote, com `tenant_audit_events` já refletindo os campos acima.

## ESCOPO (passa pelo plano, não direto ao dev)
Campo novo no recibo de export (E4); auditar a ação "verificar integridade". Escopo leve aprovado: legenda compartilhada biblioteca↔plataforma + contraste do selo travado no token (AA no tamanho de chip).

## Princípio-mãe
**Evidência nunca é conteúdo** — o Atlas mostra provas com dados mascarados; `evidência-verificada` só do runtime real (D30); o ledger nunca contém conteúdo pessoal. A prova de que um controle funciona não viola o controle.
