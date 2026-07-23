/**
 * Seed do DEMO (leva 7) — popula um banco JÁ MIGRADO com o mínimo para o
 * fluxo-alvo da F3 executável por não-desenvolvedor (runbook):
 *   1 tenant (acme) · 1 usuário por persona · 1 form pinado · 1 processo com
 *   user task que referencia esse form.
 *
 * Rodar (banco fresco e migrado — veja docs/runbooks/demo.md):
 *   DATABASE_URL=postgres://app_api:app_api_dev@localhost:5432/buildtovalue \
 *   DATABASE_MIGRATION_URL=postgres://app_migrator:app_migrator_dev@localhost:5432/buildtovalue \
 *   pnpm --filter @platform/api run seed:demo
 *
 * Idempotência: pensado para banco FRESCO (INSERTs diretos). Rodar de novo num
 * banco já semeado dá erro de unicidade — recrie o banco (o runbook diz como).
 */
import { hashPassword } from '@platform/auth';
import {
  createDb,
  deployFormDefinition,
  deployProcessDefinition,
  withTenant,
} from '@platform/db';
import { createDiagram, createEdge, createNode, type BpmnDiagram } from '@buildtovalue/core';
import type { FormSchema } from '@buildtovalue/forms';

const MIGRATION_URL =
  process.env.DATABASE_MIGRATION_URL ?? 'postgres://app_migrator:app_migrator_dev@localhost:5432/buildtovalue';
const API_URL = process.env.DATABASE_URL ?? 'postgres://app_api:app_api_dev@localhost:5432/buildtovalue';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo1234';

const PERSONAS: { email: string; displayName: string; role: string }[] = [
  { email: 'ana@acme.test', displayName: 'Ana (negócio)', role: 'business' },
  { email: 'nara@acme.test', displayName: 'Nara (analista)', role: 'analyst' },
  { email: 'olavo@acme.test', displayName: 'Olavo (operador)', role: 'operator' },
  { email: 'admin@acme.test', displayName: 'Admin', role: 'admin' },
];

function reembolsoForm(): FormSchema {
  return {
    formId: 'reembolso',
    version: 1,
    title: 'Reembolso — aprovação',
    fields: [
      { key: 'colaborador', type: 'text', label: 'Colaborador', required: true, dataClassification: 'personal' },
      { key: 'valor', type: 'number', label: 'Valor (R$)', required: true, dataClassification: 'internal' },
      {
        key: 'justificativa',
        type: 'textarea',
        label: 'Justificativa',
        dataClassification: 'internal',
        // Igualdade (subconjunto que o servidor E o preview avaliam hoje —
        // ver pendencias §2.6: unificar o avaliador rico é item da AG-2.1).
        visibleWhen: 'decisao = "reprovar"',
      },
      // A DECISÃO é um CAMPO do form (não uma chave fora do schema): a v1
      // conclui com o form validado; um gateway pode ramificar por `decisao`.
      {
        key: 'decisao',
        type: 'radio',
        label: 'Decisão',
        required: true,
        dataClassification: 'internal',
        options: [
          { value: 'aprovar', label: 'Aprovar' },
          { value: 'reprovar', label: 'Reprovar' },
        ],
      },
    ],
  } as unknown as FormSchema;
}

function reembolsoDiagram(formRef: string): BpmnDiagram {
  const d = createDiagram({ name: 'Reembolso de despesas' });
  d.nodes.start = createNode({ id: 'start', type: 'startEvent', label: 'Início', x: 0, y: 0 });
  const review = createNode({ id: 'aprovar_reembolso', type: 'userTask', label: 'Aprovar reembolso', x: 200, y: 0 });
  review.properties.formRef = formRef;
  review.properties.candidateRoles = ['business'];
  d.nodes.aprovar_reembolso = review;
  d.nodes.end = createNode({ id: 'end', type: 'endEvent', label: 'Fim', x: 400, y: 0 });
  d.edges.e1 = createEdge({ id: 'e1', sourceId: 'start', targetId: 'aprovar_reembolso' });
  d.edges.e2 = createEdge({ id: 'e2', sourceId: 'aprovar_reembolso', targetId: 'end' });
  return d;
}

async function main(): Promise<void> {
  const migrator = createDb(MIGRATION_URL, { max: 1 });
  const api = createDb(API_URL, { max: 2 });
  try {
    const [tenant] = await migrator`
      INSERT INTO tenants (slug, name) VALUES ('acme', 'ACME Indústria') RETURNING id`;
    const tenantId = tenant.id as string;

    const passwordHash = await hashPassword(PASSWORD);
    await withTenant(migrator, tenantId, async (tx) => {
      for (const p of PERSONAS) {
        await tx`INSERT INTO users (tenant_id, email, password_hash, display_name, role)
          VALUES (${tenantId}, ${p.email}, ${passwordHash}, ${p.displayName}, ${p.role})`;
      }
    });

    const form = await deployFormDefinition(api, tenantId, { formId: 'reembolso', schema: reembolsoForm() });
    if (!form.ok) throw new Error(`deploy do form falhou: ${JSON.stringify(form)}`);
    const formRef = form.form.ref;

    const proc = await deployProcessDefinition(api, tenantId, {
      name: 'Reembolso de despesas',
      diagram: reembolsoDiagram(formRef),
      engineVersion: 'demo',
    });
    if (!proc.ok) throw new Error(`deploy do processo falhou: ${JSON.stringify(proc)}`);

    console.log(
      JSON.stringify(
        {
          tenant: { slug: 'acme', id: tenantId },
          login: { senha: PASSWORD, usuarios: PERSONAS.map((p) => ({ email: p.email, papel: p.role })) },
          form: formRef,
          processo: proc.definition?.registry_ref ?? proc,
          proximo: 'Suba API + worker + console e siga docs/runbooks/demo.md',
        },
        null,
        2,
      ),
    );
  } finally {
    await migrator.end();
    await api.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
