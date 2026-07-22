# Sequências do runtime (aceite F2 — "sequências 1 e 2 documentadas")

## Sequência 1 — caminho feliz: start → avanço → outbox → dispatch → job → conclusão

```mermaid
sequenceDiagram
  participant C as Cliente (SDK)
  participant API as API /v1
  participant ADV as Serviço de avanço
  participant PG as Postgres (RLS)
  participant W as Worker (LISTEN+poll)
  participant H as JobHandler (fora de tx)

  C->>API: POST /v1/instances {variables}
  API->>ADV: createAndStart(tenant, …)
  ADV->>PG: TX: INSERT instance + variables (sensitive CIFRADA, D20)
  ADV->>PG: TX: advance(StartInstance) → UPDATE state (revision N+1)<br/>+ INSERT outbox (effect_key D11) + pg_notify(btv_outbox)
  PG-->>W: NOTIFY no COMMIT (conexão DEDICADA)
  W->>PG: dispatchOutboxOnce: FOR UPDATE SKIP LOCKED<br/>aplica efeito + DELETE linha NA MESMA TX
  Note over W,PG: CreateJob → jobs (UNIQUE wait_key)<br/>EmitHistory → history_events (seq=(revision,index), UNIQUE effect_key)
  W->>PG: lockJobs (lease + lock_token D12)
  W->>H: registry.run(job) — http-call/send-email/webhook
  H-->>W: {ok, result} | {ok:false, error}
  W->>API: POST /v1/jobs/{id}/complete {lockToken, result} (D22)
  API->>ADV: advance(JobCompleted) → result persiste como variável (D13)
  ADV->>PG: TX: estado novo + efeitos terminais + pg_notify
  W->>PG: dispatch final → instância completed, outbox 0
```

## Sequência 2 — crash na janela crítica, retomada idempotente e timer boundary

```mermaid
sequenceDiagram
  participant ADV as Serviço de avanço
  participant PG as Postgres
  participant W1 as Worker A (morre)
  participant W2 as Worker B (retoma)

  ADV->>PG: TX commitada: estado + efeitos na outbox
  Note over W1: 💀 kill ANTES do dispatch —<br/>efeitos SOBREVIVEM na outbox
  W2->>PG: re-dispatch: mesmas linhas, MESMO effect_key/seq
  Note over PG: UNIQUE(wait_key)/UNIQUE(effect_key)<br/>= zero efeito duplicado
  W1->>PG: (variante) 💀 kill NO MEIO do lote → rollback TOTAL da tx
  W2->>PG: re-dispatch do lote inteiro, idempotente

  Note over W2,PG: Timer boundary (interruptivo)
  W2->>PG: sweepDueTimersOnce: fire_at <= relógio do HOST (D2)
  W2->>ADV: advance(TimerFired{waitKey})
  ADV->>PG: TX: CloseUserTask (task some da Tasklist)<br/>+ rota do boundary + marca timer 'fired' NA MESMA TX (onApplied)
  Note over PG: lease expirada: W2 re-toma o job;<br/>token velho do W1 = 409 (fencing D12).<br/>Efeito defeituoso: SAVEPOINT + backoff 2^n s;<br/>esgotado → dead-letter em incidents.
```

Propriedades que as duas sequências materializam: exatamente-uma-vez por
âncoras de unicidade (não por sorte de timing), `now` sempre do host (D2),
handler fora de transação concluindo pelo contrato público (D22), fencing por
`lock_token` (D12), história determinística `(revision, effect_index)`
(G-DAD-2) e conteúdo pessoal fora do registro histórico (ADR-0002).
