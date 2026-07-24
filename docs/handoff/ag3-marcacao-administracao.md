# Marcação de superfícies — Administração (AG-3.2 e AG-3.5)

> **De:** Designer da plataforma · **Data:** 2026-07-24
> **Par de:** `ADENDO-04-administracao.md` (recorte fechado) · protótipos `Prototipos-Administracao` (A1–A7)
> **Rito:** rótulo, voz e tratamento são do design; `kind`/rota/permissão são contrato do dev.
> Sem código. A2/A1/A3/A7 já estão prototipados — aqui fecho o que faltava (**A4/A5/A6-A**)
> e digo o que a **proposta de shape** precisa carregar do lado de design.

## 0 · Estado por tela

| Tela | Fase | Protótipo | Marcação |
|---|---|---|---|
| A1 identidade · A2 inteligência+kill-switch | AG-3.2 | ✅ | ✅ na peça (§1 confirma o que a rota precisa) |
| A3 tools · A7 export | AG-3.4 | ✅ | ✅ na peça (§5) |
| **A4 membros &amp; papéis** | AG-3.5 | ✅ | **§2 (nova)** |
| **A5 perfil, senha, preferências** | AG-3.5 | ✅ | **§3 (nova)** |
| **A6-A senha temporária** | AG-3.5 | ✅ | **§4 (nova)** |

## 1 · AG-3.2 — o que a proposta de shape precisa carregar (design)

O protótipo A2 já fixa voz e tratamento. Da rota, o design depende de três coisas:

1. **Estado do kill-switch legível em qualquer rota** — o banner “agentes pausados” aparece
   em **toda a Operação**, não só em Administração. **Correção (contrato real supera o
   rascunho — dois níveis, não um):** banner amplo = **fato** (estado · ator · hora); a
   **razão** só na tela de admin (`ai:configure`) — nunca no banner.
2. **Motivo obrigatório nas duas direções** — pausar **e** reativar. Sem `reason` no reativar,
   a trilha fica com metade da história.
3. **Config: nunca devolver a chave.** A resposta traz a **referência** (`secret://…`) e um
   booleano de conectividade; nada além disso. A tela não tem campo para segredo e a API não
   deve ter caminho de leitura dele.

## 2 · A4 · Membros &amp; papéis — marcação

**Rótulos de papel — invariantes, nunca flexionados por pessoa.** Papel é do cargo, não de
quem o ocupa; o chip não muda com o gênero da pessoa. Fixo o mapa:

| `role` (contrato) | Rótulo (design) | Uma linha de ajuda (na seleção) |
|---|---|---|
| `admin` | **Administrador** | tudo, mais a Administração do tenant |
| `analyst` | **Analista** | modela e publica processos e formulários |
| `operator` | **Operador** | opera, resolve incidentes, revela sensível (auditado) |
| `business` | **Negócio** | trabalha tarefas e formulários |

> **Correção ao meu próprio protótipo:** em A4 aparece “Administradora” para Ana Ruiz —
> flexionado pela pessoa. Errado por essa regra; o rótulo é **Administrador** para qualquer
> um. Normalizar na implementação.

**Mudar papel:** seleção com a linha de ajuda visível (a pessoa que decide precisa saber o
que está concedendo), **motivo obrigatório**, e a consequência dita antes de salvar quando
houver perda de acesso — ex.: *“Marcos perderá acesso à Operação.”*

**Desativar acesso** (o item de segurança do recorte):
- **Rótulo:** `Desativar acesso…` — família **vermelha** (é corte de acesso), com confirmação.
- **A confirmação nomeia os três efeitos:** (a) a pessoa **não consegue mais entrar**;
  (b) **tudo que ela fez continua na trilha com o nome dela** — histórico não se reescreve;
  (c) **tarefas atribuídas a ela voltam para a fila do papel** (não somem, não ficam presas).
- **Motivo obrigatório.** Reversível: quem está inativo mostra o chip `inativa` + ação `Reativar`.
- **Voz do estado:** linha esmaecida + chip textual `inativa` (nunca só a opacidade — sinal
  precisa de rótulo).

**Redefinir senha:** leva ao A6-A (§4). Rótulo `Redefinir senha`, com o subtexto
*“gera senha temporária”* — a ação não é “trocar por mim”, é “emitir uma temporária”.

**“+ Adicionar pessoa” (F4) — tratamento:** **ausente**, não desabilitada. Botão primário
inerte é affordance morta (mesmo princípio que me fez remover o “Delegar…” morto na F3): a
pessoa clica e nada acontece. No lugar, uma linha discreta no topo da lista:
*“Novas pessoas são provisionadas pela BuildToValue nesta fase.”* Cumpre o aceite 6 (motivo
à vista) sem prometer um clique que não existe.

## 3 · A5 · Perfil, senha e preferências — marcação

- **Onde vive:** acessível pelo **nome do usuário no topo**, em qualquer rota — não é
  Administração (todo usuário tem perfil, inclusive `business`).
- **E-mail é login:** campo bloqueado com o rótulo mono `bloqueado` e a explicação
  *“é o seu login — mudança pede confirmação do administrador”*. Sem ícone colorido.
- **Papel** aparece como leitura (`definido pelo administrador`) — o usuário não muda o próprio.
- **Trocar senha:**
  - Ordem: senha atual → nova → repetir. Medidor de força **com rótulo textual**
    (`forte`), nunca só a barra colorida.
  - **Requisitos como checklist que se resolve** (✓ ao cumprir), não uma lista de erros.
  - **Consequência dita antes:** *“ao trocar, as outras sessões são encerradas — você
    continua conectado só aqui.”*
  - A troca é auditada **como ato**; a senha nunca entra em trilha, log ou resposta.
  - **Primeiro acesso com senha temporária:** a troca é **obrigatória** — a tela abre
    bloqueando a navegação, com a voz *“defina sua senha para continuar”* (não um aviso
    dispensável).
- **Preferências:** fuso horário e formato de data. A justificativa fica visível na tela
  (*“a Operação e as trilhas mostram horários; sem fuso, um operador em outro estado
  interpreta errado a hora de um incidente”*) — é o que impede tratarem isso como enfeite.
- **Moeda/câmbio é do tenant** (A1), não do usuário: um valor de orçamento não pode variar
  conforme quem olha.

## 4 · A6-A · Senha temporária — marcação

- **Aparece uma vez, e a tela diz isso antes de gerar:** *“a senha aparece uma única vez e
  não é recuperável depois.”*
- **Tratamento:** card em **dourado/atenção** (é material sensível em tela), valor em **mono
  grande**, com validade e regra à vista: `válida por 24h · uso único · troca obrigatória`.
- **Nunca em toast/notificação** — dispensável por acidente e some sem ação. Card explícito,
  com ação primária **`Copiar e confirmar`** (copiar e confirmar são o mesmo gesto: evita
  confirmar sem ter copiado).
- **Motivo obrigatório** (ex.: *“solicitou por telefone — perdeu o acesso”*).
- **Depois de fechar:** a tela volta à lista com a confirmação *“senha temporária emitida ·
  entregue pessoalmente”* e o ato na trilha. **O valor não reaparece em lugar nenhum** — é o
  aceite 4 (estende o leak-fail).
- **Entrega é humana** nesta fase (sem e-mail): a cópia dita isso, para ninguém esperar
  que o sistema envie.

## 5 · A3/A7 (AG-3.4) — já marcados na peça, dois lembretes

- **A3 tools:** o toggle é a única coisa editável; **efeito e autorização são leitura** (vêm
  do contrato). A tela **afirma** a invariante: irreversível/compromisso externo nunca
  aparece como “automática”. `proibida` é estado, com rótulo — não um toggle desligado.
- **A7 export:** a **primeira linha a corrigir** é `audit:export` no `capabilities.ts` do
  console — sem ela o botão não pode nem ser renderizado. O recibo é o do Atlas E4
  (`export_id` · filtros · contagem · resumo · bloco · solicitante), e **a exportação é ela
  própria auditada**.

## 6 · Aceite de design (o que confiro no G-UX-3 de cada uma)

Rótulos de papel invariantes (sem flexão por pessoa); desativar nomeia os três efeitos e
preserva a trilha; “+ Adicionar pessoa” **ausente** com motivo à vista, não botão morto;
troca de senha diz que encerra outras sessões e é obrigatória no primeiro acesso; senha
temporária em card (não toast), uma vez, com `Copiar e confirmar`; kill-switch com estado
legível fora da Administração e motivo nas duas direções; chave nunca devolvida pela API;
alvos ≥ 44px; nenhum sinal só por cor; nenhum color-emoji.
