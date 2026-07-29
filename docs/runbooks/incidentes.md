# Runbook — resposta a incidentes

> **Item 5 do Gate de Piloto (G-LGPD-4).** O gate exige plano escrito **e**
> simulação executada. Este documento é o plano; o §8 é o registro do ensaio.
> Documento sem ensaio reprova o item.

Vale para o ambiente de **demo/teste** hoje e é a base do de piloto. Onde os
dois divergem, está marcado.

---

## 1. O que é incidente

Qualquer evento que **degrade o serviço**, **comprometa dado** ou **quebre uma
garantia que a plataforma afirma ter** — isolamento entre tenants, imutabilidade
da trilha, confidencialidade de campo `sensitive`.

A última categoria é a que se esquece: se a trilha aceitar `UPDATE`, nada
"cai", nenhum alerta dispara, e a plataforma passa a mentir. Isso é incidente
de severidade máxima mesmo com tudo verde.

## 2. Severidades

| Sev | Critério | Resposta | Comunicação |
|---|---|---|---|
| **S1** | Dado pessoal exposto/perdido · isolamento entre tenants rompido · trilha adulterável | imediata, larga tudo | dono + DPO na hora; ANPD/titulares conforme LGPD art. 48 |
| **S2** | Serviço fora, ou dado íntegro mas inacessível | imediata em horário comercial | dono na hora |
| **S3** | Degradação sem perda (lentidão, fila crescendo, backup falhando) | no próximo dia útil | registro; sem acionamento |
| **S4** | Defeito sem efeito operacional | backlog | nenhuma |

**Na dúvida entre dois níveis, assuma o mais alto.** Rebaixar depois com
evidência é barato; descobrir tarde que era S1 não é.

`backup falhando` é S3 e não S4 de propósito: não dói hoje, e é exatamente o que
transforma o próximo incidente em perda definitiva.

## 3. Papéis

Hoje uma pessoa acumula todos. O runbook os separa porque **as funções
competem entre si** — quem está com as mãos no banco não consegue avaliar prazo
legal ao mesmo tempo. Acumulando, faça na ordem: conter, depois comunicar.

| Papel | Responsabilidade |
|---|---|
| **Coordenação** | decide severidade, decide restaurar, encerra |
| **Execução** | contém e restaura; não decide escopo sozinho |
| **Privacidade (DPO)** | avalia se houve dado pessoal; conduz prazo legal |
| **Comunicação** | fala com quem usa; único a falar para fora |

## 4. Comunicação

- **Interna:** canal do dono, tempo real.
- **Quem usa a plataforma:** em S1/S2, avisar que está fora **antes** de ter a
  causa. "Estamos fora, investigando, aviso em 1h" vale mais que silêncio.
- **Externa (S1 com dado pessoal):** LGPD art. 48 — comunicar ANPD e titulares
  em prazo razoável. **Quem decide é o DPO, não a execução.**
- Durante o incidente, **não apague nada** sem registrar antes: log, dump,
  `docker compose ps`. O que se apaga na pressa é o que faltaria no post-mortem.

## 5. Contenção

Antes de consertar, **pare o sangramento** — e preserve evidência.

```bash
cd /opt/btv/buildtovalue-platform/deploy
docker compose ps                         # o que está de pé
docker compose logs --tail 200 api worker > /tmp/incidente-$(date +%FT%H%M).log
curl -sf http://127.0.0.1:3000/ready      # a api enxerga o banco?
```

Por tipo:

| Situação | Contenção |
|---|---|
| Vazamento por credencial | rotacionar **primeiro** (§5.1), investigar depois |
| Dado sendo corrompido | `docker compose stop api worker` — parar de escrever vale mais que ficar no ar |
| Agente/IA agindo errado | **kill-switch do tenant** (P4, auditado); não precisa derrubar a plataforma |
| Serviço fora sem perda | investigar com tudo de pé; não reiniciar antes de coletar log |

### 5.1 Rotação de credencial

Pelo caminho auditado da própria plataforma —
`POST /v1/admin/members/:id/reset-password`, com motivo obrigatório. Passo a
passo em `deploy-plataforma-vps.md` §5.1.

Rotacionar por `UPDATE` no banco descarta a trilha que prova que a resposta
aconteceu. Num incidente de privacidade, essa trilha **é** parte da resposta.

## 6. Restauração

Ver `database.md` para os papéis e `deploy-vps.md` §6 para os comandos.

**A ordem importa:** restaure num banco **descartável** primeiro, confira, e só
então promova. Restaurar direto por cima do banco de produção destrói a única
cópia do estado corrompido — que pode ser a evidência do incidente.

**Sempre a partir da cópia REMOTA**, não do dump local: se o incidente for de
disco ou de máquina, o dump local é suspeito ou não existe. O ensaio do §8 usa
o remoto exatamente por isso.

```bash
# 1. baixar do remoto e CONFERIR a integridade antes de qualquer coisa
rclone copy "$BACKUP_REMOTE/buildtovalue-AAAAMMDDTHHMMSSZ.dump" /tmp/restore/
rclone copy "$BACKUP_REMOTE/buildtovalue-AAAAMMDDTHHMMSSZ.dump.sha256" /tmp/restore/
cd /tmp/restore && sha256sum -c buildtovalue-*.dump.sha256     # ABORTE se falhar

# 2. restaurar num banco DESCARTÁVEL
docker compose exec -T postgres psql -U app_migrator \
  -c "CREATE DATABASE btv_restore OWNER app_migrator"
docker compose exec -T postgres pg_restore -U app_migrator -d btv_restore --no-owner \
  < /tmp/restore/buildtovalue-*.dump

# 3. conferir ANTES de promover
docker compose exec -T postgres psql -U app_migrator -d btv_restore \
  -c "SELECT count(*) FROM history_events; SELECT count(*) FROM instances;"
```

Promover só depois da conferência. Registre o horário do dump: **tudo que
aconteceu depois dele está perdido** — essa é a janela de perda, e ela entra na
comunicação.

## 7. Encerramento e post-mortem

Encerra quando, e só quando:

1. serviço respondendo (`/ready` ok, tarefa abre na Tasklist);
2. **janela de perda quantificada** — o que se perdeu entre o dump e o
   incidente, em número, não em adjetivo;
3. causa raiz identificada **ou** monitoramento posto para pegá-la de novo;
4. comunicação feita, incluindo prazo legal se S1.

Post-mortem em até 5 dias úteis, **sem culpado**: se a resposta depende de
alguém ter lembrado de algo, o defeito é do sistema. Registrar: linha do tempo,
detecção (quem viu, e por quê não foi antes), janela de perda, o que faltou no
runbook, e ações com dono e prazo.

**Toda lição vira mudança neste arquivo.** Post-mortem que não altera o runbook
não aconteceu.

## 8. Ensaio (registro)

> O item 5 do gate pede **simulação executada**. Aqui vai o registro de cada
> ensaio: data, cenário, tempo, e o que mudou no runbook por causa dele.

Ver `docs/reports/` para os registros detalhados quando houver.

| Data | Cenário | Tempo até restauração | sha256 remoto | Resultado |
|---|---|---|---|---|
| _pendente_ | banco corrompido, restauração a partir da cópia remota | — | — | — |

**Ensaio pendente.** Ele depende de duas coisas que ainda não existem na VPS: o
crontab instalado e o `BACKUP_REMOTE` definido — e este último depende da
decisão de infra do piloto. Enquanto isso, o item 5 do gate **não fecha**, e o
pendente "ensaio de restauração a partir do remoto" do item 3 também não.

Fazer o ensaio contra o dump local seria mais fácil e não valeria: provaria o
caminho que já foi ensaiado em 22/07, não o que o gate pede.
