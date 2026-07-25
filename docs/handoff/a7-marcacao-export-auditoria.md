# A7 — Marcação da tela de export de auditoria (recibo com a garantia real)

> **De:** Designer da plataforma · **Data:** 2026-07-25
> **Par de:** `docs/handoff/a7-inventario-export-auditoria.md` (main)
> **Rito:** rótulo, voz e tratamento são do design; rota/RBAC/`kind` são contrato. Sem código.
> **Substitui** a seção A7 do `Prototipos Administracao.dc.html` no que ela prometia a mais.

## 0 · O que muda e por quê

O protótipo dizia **“ancorado · bloco #4903”**. Não existe bloco, não existe notarização
externa: a garantia real é `self-recorded` — a plataforma registra o próprio digest na
própria trilha. Um recibo que afirma notarização externa inexistente não é exagero de UI; é
**evidência de conformidade falsa**, entregue justamente a quem audita. É a correção mais
séria das quatro deste rito.

> Já corrigi a mesma promessa nos três artefatos onde ela estava replicada (Atlas E4,
> Administração A7, Governança E3) — verificado por contagem, zero ocorrências.

## 1 · Cartão do recibo — voz e tratamento *(pergunta 1)*

**Reusar o `EvidenceSeal` no estado `ancoravel`** (o mesmo que o dev criou e eu ratifiquei na
fundação, justamente por recusar dizer “verificado”), **não** um tratamento próprio da tela.
Foi para esta situação que aquele estado nasceu; inventar aqui um segundo vocabulário de
garantia recriaria a divergência que a ratificação fechou.

**Hierarquia do cartão** — a garantia vem antes do detalhe técnico:

1. **Selo + nome da garantia:** `EvidenceSeal ancoravel` + **“Registro próprio”**.
   Rótulo humano; `self-recorded` aparece em mono ao lado, porque é o termo do dado.
2. **Uma frase que fecha a expectativa**, em texto corrido, não em nota de rodapé:
   *“O digest fica registrado na própria trilha da plataforma. **Não há notarização
   externa.**”* — o negrito é onde o auditor decide se aquilo serve para ele.
3. **Digest** (mono, truncado com cópia integral disponível) · **algoritmo** · **contagem de
   eventos** · **filtros aplicados** · **gerado em**.
4. **`generatedBy` via `ActorBadge`** *(já fechado pelo dono)* — mesma linguagem da timeline.

**Cobertura das duas trilhas + `unanchoredCount` — a parte que pode virar lista ilegível.**
Não mostrar `throughXid`/`throughTime` crus lado a lado. Trato como **uma afirmação com duas
provas**:

- **Linha-veredito, primeiro:** `unanchoredCount = 0` →
  ✓ **“Todas as 3.412 linhas deste export estão dentro da cobertura registrada.”**
  `unanchoredCount > 0` → **âmbar**: ⚠ **“{n} linhas deste export estão fora da cobertura
  registrada.”** — atenção, **nunca vermelho**: não é falha do sistema, é um fato sobre o
  alcance do registro, e o auditor precisa saber sem alarme falso.
- **As duas trilhas abaixo, rotuladas em português:** *“trilha do tenant — coberta até
  24/07 14:20”* e *“trilha da instância — sem cobertura registrada”* (quando `null`).
  **`null` é ausência honesta**, com essa voz — nunca “—”, nunca vazio, nunca zero.
- **Nada de `throughXid` na tela.** É identificador de transação, diagnóstico puro: vive no
  detalhe expansível junto do `anchorRef` completo, mesma disciplina do `usage`/`fxRate` na
  timeline.

**Proibido nesta tela:** “bloco #N”, “ancorado”, “verificado”, “notarizado” — e qualquer
palavra que sugira terceiro atestando. **Gatilho de mudança:** quando a ancoragem externa
existir (WAL imutável, infra do Gate de Piloto), `assurance` vira `externally-anchored`, o
selo pode então dizer verificado e **este parágrafo é reaberto** — não antes.

## 2 · Verificar integridade — sem lookup por id *(pergunta 2)*

**Os dois caminhos, com um primário claro.** O gesto real do auditor é *“tenho um arquivo e
um recibo; isto ainda bate?”*.

- **Primário — arrastar/selecionar o arquivo exportado.** O cliente extrai digest e filtros
  dele. É o caminho de menor atrito e o que mais se parece com o que a pessoa tem em mãos.
- **Secundário — colar o JSON do recibo** (textarea), para quem guardou só o recibo.
- **Nunca “informe o `export_id`”**: não existe rota que o resolva. Removido da tela — e o
  cartão também não exibe `export_id` como se fosse recuperável (decisão D do inventário).
  Se algum identificador aparecer, é o **digest truncado**, rotulado como digest.

**Resultado da verificação — três vozes distintas:**

| Resultado | Voz | Família |
|---|---|---|
| `matches: true` | ✓ **“Confere — o arquivo é idêntico ao registrado.”** | verde |
| `matches: false` | ⚠ **“Não confere — a trilha mudou desde este export.”** + os dois digests lado a lado (esperado × atual) | **âmbar**, nunca vermelho |
| falha de rede/5xx | ✕ **“Não foi possível verificar agora.”** + “Tentar novamente” | vermelho |

`matches:false` **é resposta honesta, não erro** — vem 200. Pintá-lo de vermelho ensinaria o
auditor que o sistema quebrou, quando na verdade ele acabou de receber a informação correta.
Distinguir isso de uma falha real é o ponto inteiro desta tela.

## 3 · Onde mora na navegação *(pergunta 3)*

**Sim, entrada nova de Administração no shell** — é a 5ª rota do ADENDO-04 (D32), e a A7 é
seu item “Auditoria”. Visível a quem tem `audit:export` (**admin + auditor**); para os
demais, **ausente** — não desabilitada (mesma regra do “+ Adicionar pessoa”: botão inerte é
affordance morta).

Consequência de papel: o **auditor** provavelmente entra no produto e só tem esta tela. Então
Administração precisa **abrir direto em Auditoria** quando é o único item visível ao papel —
nada de cair numa Identidade que ele não pode editar.

## 4 · Estados não-ideais *(§4 do inventário — o protótipo não cobria nenhum)*

- **Export vazio** (`count: 0`): **recibo válido, não erro.**
  *“Nenhum evento neste recorte.”* + o recibo normal ao lado. Nunca a voz de falha, e nunca
  esconder o recibo — um export vazio verificável é um resultado legítimo de auditoria.
- **Exportando:** botão em estado ocupado com `aria-busy`, texto *“Preparando o export…”*.
  Pode demorar; o silêncio faria clicar de novo.
- **Falha do export:** erro explícito + “Tentar novamente”, com `aria-live`. **Nunca**
  degradar para “0 eventos” — seria transformar uma falha em uma afirmação falsa sobre a
  trilha, o mesmo defeito de origem desta tela.
- **CSV × JSON:** no CSV o recibo vem no header. **A apresentação é idêntica** — o mesmo
  cartão, na mesma posição. A fonte é detalhe de implementação; o auditor não deve perceber
  diferença nem procurar o recibo em dois lugares.

## 5 · Filtros *(já fechados pelo dono — só o tratamento)*

Ator em **dois campos** (`actorType` seleção + `actorId` texto) e `resourceType`/`resourceId`
presentes. Os quatro pares ficam numa grade de duas colunas, agrupados: **quando** (período)
· **quem** (ator) · **o quê** (tipo de evento) · **sobre o quê** (recurso). O preset
“últimos 30 dias” continua preset; a tela mostra as datas resolvidas em mono ao lado, para o
recibo e o filtro nunca parecerem coisas diferentes.

## Aceite de design (G-UX-3)

`EvidenceSeal ancoravel` + “Registro próprio”; a frase “não há notarização externa” visível
no cartão; nenhuma ocorrência de bloco/ancorado/verificado/notarizado; veredito de cobertura
antes das duas trilhas, `unanchoredCount > 0` em âmbar; `null` com voz de ausência;
`throughXid`/`anchorRef` só no detalhe; verificação por arquivo (primário) ou recibo colado,
sem `export_id`; `matches:false` âmbar e distinto de falha; export vazio com recibo válido;
Administração visível só a `audit:export`, abrindo em Auditoria para o auditor; alvos ≥44px;
nenhum sinal só por cor; nenhum color-emoji.
