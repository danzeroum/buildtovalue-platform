/**
 * Smoke do FLUXO-ALVO (leva 7) — prova o runbook de ponta a ponta contra
 * servidores REAIS (API + worker) e o banco SEMEADO: login → iniciar instância
 * → o worker materializa a user task da outbox → claim → conclusão validada no
 * servidor → instância `completed`. Sobe os dois processos, dirige o fluxo por
 * HTTP, checa, e derruba tudo. Um único processo em foreground (o sandbox não
 * mantém servidores destacados entre chamadas).
 *
 * Pré: banco `buildtovalue` migrado e semeado (pnpm --filter @platform/api run
 * seed:demo). Rodar: pnpm --filter @platform/api run smoke:flow
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const API = 'http://127.0.0.1:3000';
const children: ChildProcess[] = [];

function start(name: string, entry: string): void {
  const child = spawn('node', ['--env-file=.env', entry], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[${name}] ${b}`));
  child.on('exit', (code) => {
    if (code && code !== 0 && !shuttingDown) {
      console.error(`[${name}] saiu inesperadamente com código ${code}`);
    }
  });
  children.push(child);
}

let shuttingDown = false;
function teardown(): void {
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
}

async function waitFor(fn: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout esperando: ${label}${lastErr ? ` (último erro: ${String(lastErr)})` : ''}`);
}

async function main(): Promise<void> {
  start('api', 'apps/api/dist/server.js');
  start('worker', 'apps/worker/dist/main.js');

  await waitFor(async () => (await fetch(`${API}/health`)).ok, 'API /health');

  // 1) login (admin cobre todo o fluxo)
  const login = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant: 'acme', email: 'admin@acme.test', password: 'demo1234' }),
  });
  if (!login.ok) throw new Error(`login falhou: ${login.status} ${await login.text()}`);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const bearer = { authorization: `Bearer ${accessToken}` }; // sem body (claim)
  const auth = { ...bearer, 'content-type': 'application/json' }; // com body JSON

  // 2) iniciar instância (Idempotency-Key)
  const started = await fetch(`${API}/v1/instances`, {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ definitionRef: 'Reembolso de despesas@1', businessKey: 'RB-SMOKE-1' }),
  });
  if (started.status !== 201) throw new Error(`start falhou: ${started.status} ${await started.text()}`);
  const instance = (await started.json()) as { id: string };
  console.log(`▶ instância iniciada ${instance.id}`);

  // 3) o WORKER materializa a user task da outbox — polling até aparecer
  let taskId = '';
  await waitFor(async () => {
    const res = await fetch(`${API}/v1/user-tasks?status=open&instanceId=${instance.id}`, { headers: bearer });
    if (!res.ok) return false;
    const body = (await res.json()) as { items: { id: string }[] };
    if (body.items.length > 0) {
      taskId = body.items[0].id;
      return true;
    }
    return false;
  }, 'user task materializada pelo worker');
  console.log(`▶ user task criada ${taskId}`);

  // 4) claim → token rotacionado
  const claim = await fetch(`${API}/v1/user-tasks/${taskId}/claim`, { method: 'POST', headers: bearer });
  if (!claim.ok) throw new Error(`claim falhou: ${claim.status} ${await claim.text()}`);
  const { claimToken } = (await claim.json()) as { claimToken: string };

  // 5) conclusão validada no servidor (form pinado)
  const done = await fetch(`${API}/v1/user-tasks/${taskId}/completion`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      claimToken,
      submission: { colaborador: 'Marina Duarte', valor: 1200, decisao: 'aprovar' },
    }),
  });
  if (!done.ok) throw new Error(`conclusão falhou: ${done.status} ${await done.text()}`);
  const { instanceStatus } = (await done.json()) as { instanceStatus: string };
  console.log(`▶ tarefa concluída — instância agora: ${instanceStatus}`);

  // 6) o Operate vê a instância concluída
  const detail = await fetch(`${API}/v1/instances/${instance.id}`, { headers: auth });
  const inst = (await detail.json()) as { status: string; currentElements: string[] };
  if (inst.status !== 'completed') throw new Error(`esperava completed, veio ${inst.status}`);

  console.log('\n✅ FLUXO-ALVO OK: login → iniciar → worker cria task → claim → concluir → completed');
}

main()
  .then(() => {
    teardown();
    setTimeout(() => process.exit(0), 500);
  })
  .catch((err) => {
    console.error('\n❌', err.message ?? err);
    teardown();
    setTimeout(() => process.exit(1), 500);
  });
