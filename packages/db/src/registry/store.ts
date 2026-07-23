import { createEngine, type Engine } from '@buildtovalue/engine';
import type { BpmnDiagram } from '@buildtovalue/core';
import { validateFormSchema, type FormSchema, type SchemaIssue } from '@buildtovalue/forms';
import type { Sql, TransactionSql } from '../client.js';
import { withTenant } from '../tenancy.js';
import { conditionEvaluator } from '../runtime/definitions.js';
import { effectRequiresGate } from '@buildtovalue/agentflow';
import { deriveDecisionRouting, lintBlocks, lintDiagram, toolEffectGateViolations, type LintIssue } from './lint.js';
import { toolEffectOfTx } from './toolStore.js';

/**
 * Registry de definições (F3.1, shape /v1 §1/§2b): deploy IMUTÁVEL com lint
 * no gate — erro = nada gravado. Versões sobem por nome; `registry_ref` =
 * `name@version` é o que instances.definition_ref aponta.
 */
export interface ProcessDefinitionRow {
  id: string;
  name: string;
  version: number;
  registry_ref: string;
  diagram: BpmnDiagram;
  engine_version: string;
  bpmn_version: string;
  created_at: string;
}

export interface FormDefinitionRow {
  id: string;
  form_id: string;
  version: number;
  ref: string;
  schema: FormSchema;
  created_at: string;
}

export type DeployProcessOutcome =
  | { ok: true; definition: ProcessDefinitionRow; warnings: LintIssue[] }
  | { ok: false; issues: LintIssue[] };

export type DeployFormOutcome =
  | { ok: true; form: FormDefinitionRow }
  | { ok: false; issues: SchemaIssue[] };

export async function deployProcessDefinition(
  sql: Sql,
  tenantId: string,
  input: { name: string; diagram: BpmnDiagram; engineVersion: string; createdBy?: string },
): Promise<DeployProcessOutcome> {
  const issues = lintDiagram(input.diagram);
  return withTenant(sql, tenantId, async (tx) => {
    // formRefs do diagrama precisam EXISTIR no registry de forms (§2:
    // EXEC_FORM_REF_MISSING resolve contra o registry, não só presença). O
    // MESMO passo carrega o schema para validar a decisionVar (etapa 6) contra
    // os campos sensitive do formulário pinado.
    const userTasks = Object.values(input.diagram.nodes).filter((n) => n.type === 'userTask');
    for (const node of userTasks) {
      const ref = typeof node.properties.formRef === 'string' ? node.properties.formRef : undefined;
      let schema: FormSchema | undefined;
      if (ref) {
        const [found] = await tx<{ schema: FormSchema }[]>`
          SELECT schema FROM form_definitions WHERE ref = ${ref}`;
        if (!found) {
          issues.push({
            code: 'EXEC_FORM_REF_MISSING',
            severity: 'error',
            elementId: node.id,
            message: `formRef '${ref}' não existe no registry de formulários`,
          });
        } else {
          schema = found.schema;
        }
      }
      // etapa 6 (opção B): decisionVar declarada no BPMN não pode COLIDIR com a
      // variável reservada `value` nem com um campo `sensitive` do formulário —
      // a decisão é roteamento (comparada por igualdade no gateway), jamais um
      // slot de dado pessoal. Validado no DEPLOY (gate), não só em runtime.
      const decisionVar =
        typeof node.properties.decisionVar === 'string' && node.properties.decisionVar.length > 0
          ? node.properties.decisionVar
          : undefined;
      if (decisionVar) {
        if (decisionVar === 'value') {
          issues.push({
            code: 'EXEC_DECISION_VAR_RESERVED',
            severity: 'error',
            elementId: node.id,
            message: `decisionVar '${decisionVar}' colide com a variável reservada 'value'`,
          });
        }
        const sensitiveClash = (schema?.fields as { key: string; dataClassification?: string }[] | undefined)?.find(
          (f) => f.key === decisionVar && f.dataClassification === 'sensitive',
        );
        if (sensitiveClash) {
          issues.push({
            code: 'EXEC_DECISION_VAR_SENSITIVE',
            severity: 'error',
            elementId: node.id,
            message: `decisionVar '${decisionVar}' colide com o campo sensitive '${decisionVar}' do formulário — a decisão (roteamento) não pode ocupar um slot sensível`,
          });
        }
      }
    }
    // Gate D31 (etapa 5): elementos que declaram uma tool cujo efeito EXIGE gate
    // (resolvido contra o registry de tools) precisam de um btv:gate a jusante. A
    // resolução do efeito é aqui (tx); a alcançabilidade no grafo é pura no lint.
    const gatedElementIds: string[] = [];
    for (const node of Object.values(input.diagram.nodes)) {
      const toolRef = typeof node.properties.toolRef === 'string' ? node.properties.toolRef : undefined;
      if (!toolRef) continue;
      const effect = await toolEffectOfTx(tx, toolRef);
      if (effect && effectRequiresGate(effect)) gatedElementIds.push(node.id);
    }
    issues.push(...toolEffectGateViolations(input.diagram, gatedElementIds));

    if (lintBlocks(issues)) return { ok: false, issues };

    // versão nova por nome; a UNIQUE (tenant, name, version) segura corrida.
    const [row] = await tx<ProcessDefinitionRow[]>`
      INSERT INTO process_definitions
        (tenant_id, name, version, registry_ref, diagram, engine_version, created_by)
      SELECT ${tenantId}, ${input.name},
             COALESCE(MAX(version), 0) + 1,
             ${input.name} || '@' || (COALESCE(MAX(version), 0) + 1),
             ${tx.json(input.diagram as never)}, ${input.engineVersion},
             ${input.createdBy ?? null}
      FROM process_definitions WHERE name = ${input.name}
      RETURNING id, name, version, registry_ref, diagram, engine_version, bpmn_version, created_at`;
    return { ok: true, definition: row, warnings: issues };
  });
}

export async function deployFormDefinition(
  sql: Sql,
  tenantId: string,
  input: { formId: string; schema: FormSchema; createdBy?: string },
): Promise<DeployFormOutcome> {
  if (input.schema.formId !== undefined && input.schema.formId !== input.formId) {
    return {
      ok: false,
      issues: [
        {
          code: 'SCHEMA_FORM_ID',
          message: `formId do corpo ('${input.formId}') diverge do schema ('${String(input.schema.formId)}')`,
        },
      ],
    };
  }
  return withTenant(sql, tenantId, async (tx) => {
    // O REGISTRY atribui a versão (imutabilidade: re-deploy = versão nova) e
    // a carimba no schema ANTES do lint — identidade formId@versão é única.
    const [next] = await tx`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM form_definitions WHERE form_id = ${input.formId}`;
    const version = Number(next.version);
    const candidate: FormSchema = { ...input.schema, formId: input.formId, version };
    // Formato da F0b.5 é o GATE: `value` reservada, dataClassification
    // obrigatório por campo — validateFormSchema é o MESMO lint do editor.
    const issues = validateFormSchema(candidate);
    if (issues.length > 0) return { ok: false, issues };
    const [row] = await tx<FormDefinitionRow[]>`
      INSERT INTO form_definitions (tenant_id, form_id, version, ref, schema, created_by)
      VALUES (${tenantId}, ${input.formId}, ${version},
              ${`${input.formId}@${version}`},
              ${tx.json(candidate as never)}, ${input.createdBy ?? null})
      RETURNING id, form_id, version, ref, schema, created_at`;
    return { ok: true, form: row };
  });
}

export async function getProcessDefinition(
  sql: Sql,
  tenantId: string,
  idOrRef: string,
): Promise<ProcessDefinitionRow | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<ProcessDefinitionRow[]>`
      SELECT id, name, version, registry_ref, diagram, engine_version, bpmn_version, created_at
      FROM process_definitions
      WHERE registry_ref = ${idOrRef}
         OR id::text = ${idOrRef}`;
    return rows[0];
  });
}

/**
 * Roteamento da decisão de um elemento (etapa 6): lê o diagrama imutável do
 * `definitionRef` e deriva `decisionVar` + `decisionOptions` (valores exatos do
 * gateway a jusante) pelo MESMO caminhamento do lint. Roda DENTRO de uma tx
 * (RLS ativo). Definição embutida (skeleton@1/example@1) não está no registry
 * → sem decisão. Fonte única de verdade é o diagrama — nada em user_tasks.
 */
export async function getDefinitionDecisionInfo(
  tx: TransactionSql,
  definitionRef: string,
  elementId: string,
): Promise<{ decisionVar: string | null; decisionOptions: string[] | null }> {
  const [row] = await tx<{ diagram: BpmnDiagram }[]>`
    SELECT diagram FROM process_definitions WHERE registry_ref = ${definitionRef}`;
  if (!row) return { decisionVar: null, decisionOptions: null };
  const routing = deriveDecisionRouting(row.diagram, elementId);
  return { decisionVar: routing.decisionVar, decisionOptions: routing.options };
}

export async function getFormDefinitionByRef(
  sql: Sql,
  tenantId: string,
  ref: string,
): Promise<FormDefinitionRow | undefined> {
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx<FormDefinitionRow[]>`
      SELECT id, form_id, version, ref, schema, created_at
      FROM form_definitions WHERE ref = ${ref}`;
    return rows[0];
  });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Cursor opaco (§0): base64 de `${created_at}|${id}` — ordem estável. */
function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}
// NB: nas comparações, o parâmetro do cursor entra como ::text::timestamptz
// de propósito — o describe do driver tipa o placeholder como TEXT e a
// string vai crua; sem isso o postgres.js serializa via Date e PERDE os
// microssegundos (páginas repetiriam a linha de fronteira).
function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = raw.lastIndexOf('|');
  if (at <= 0) return undefined;
  return { createdAt: raw.slice(0, at), id: raw.slice(at + 1) };
}

export async function listProcessDefinitions(
  sql: Sql,
  tenantId: string,
  options: { cursor?: string; limit?: number; name?: string } = {},
): Promise<Page<Omit<ProcessDefinitionRow, 'diagram'>>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, name, version, registry_ref, engine_version, bpmn_version, created_at,
             created_at::text AS created_at_cursor
      FROM process_definitions
      WHERE (${options.name ?? null}::text IS NULL OR name = ${options.name ?? null})
        AND (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit) as unknown as Omit<ProcessDefinitionRow, 'diagram'>[];
    const nextCursor =
      rows.length > limit
        ? encodeCursor(String(rows[limit - 1].created_at_cursor), String(rows[limit - 1].id))
        : null;
    return { items, nextCursor };
  });
}

/**
 * Projeção iniciável (AG-2.1, etapa 5 [GATE]): {id, name, version, registryRef}
 * — SEM diagrama/XML. Serve o Console para quem tem `instances:start` mas NÃO
 * `definitions:read` (o business): lista o que dá para iniciar sem expor o
 * modelo. `registry_ref` (name@version) é o IDENTIFICADOR CANÔNICO que a
 * instância aponta — o cliente o usa VERBATIM (reconstruir name@version no
 * cliente quebraria sob normalização/slug ou nome com caractere especial).
 *
 * SOMENTE a versão ATIVA de cada nome: `DISTINCT ON (name) … version DESC`
 * traz a última publicada por nome. Versão aposentada (substituída por uma
 * mais nova) NÃO aparece — iniciar uma versão velha recriaria o beco que a
 * etapa fecha. Deploy é imutável: não há rascunho, todo registro é publicado.
 */
export interface StartableDefinitionRow {
  id: string;
  name: string;
  version: number;
  registry_ref: string;
}

export async function listStartableDefinitions(
  sql: Sql,
  tenantId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<Page<StartableDefinitionRow>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  return withTenant(sql, tenantId, async (tx) => {
    // CTE `latest`: uma linha por nome (a maior versão). O RLS já restringe ao
    // tenant, então DISTINCT ON (name) é por-tenant. Paginação estável sobre o
    // conjunto filtrado, mesmo cursor opaco (created_at, id) das outras listas.
    const rows = await tx`
      WITH latest AS (
        SELECT DISTINCT ON (name) id, name, version, registry_ref, created_at
        FROM process_definitions
        ORDER BY name, version DESC
      )
      SELECT id, name, version, registry_ref,
             created_at::text AS created_at_cursor
      FROM latest
      WHERE (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      version: r.version as number,
      registry_ref: r.registry_ref as string,
    }));
    const nextCursor =
      rows.length > limit
        ? encodeCursor(String(rows[limit - 1].created_at_cursor), String(rows[limit - 1].id))
        : null;
    return { items, nextCursor };
  });
}

export async function listFormDefinitions(
  sql: Sql,
  tenantId: string,
  options: { cursor?: string; limit?: number; formId?: string } = {},
): Promise<Page<Omit<FormDefinitionRow, 'schema'>>> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  return withTenant(sql, tenantId, async (tx) => {
    const rows = await tx`
      SELECT id, form_id, version, ref, created_at,
             created_at::text AS created_at_cursor
      FROM form_definitions
      WHERE (${options.formId ?? null}::text IS NULL OR form_id = ${options.formId ?? null})
        AND (${after?.createdAt ?? null}::text::timestamptz IS NULL
             OR (created_at, id) > (${after?.createdAt ?? null}::text::timestamptz, ${after?.id ?? null}::uuid))
      ORDER BY created_at, id
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit) as unknown as Omit<FormDefinitionRow, 'schema'>[];
    const nextCursor =
      rows.length > limit
        ? encodeCursor(String(rows[limit - 1].created_at_cursor), String(rows[limit - 1].id))
        : null;
    return { items, nextCursor };
  });
}

/** Fachada do registry consumida pela API (mesmo padrão do PlatformRuntime). */
export interface PlatformRegistry {
  lintProcess(diagram: BpmnDiagram): LintIssue[];
  deployProcess(
    tenantId: string,
    input: { name: string; diagram: BpmnDiagram; createdBy?: string },
  ): Promise<DeployProcessOutcome>;
  getProcess(tenantId: string, idOrRef: string): Promise<ProcessDefinitionRow | undefined>;
  listProcesses(
    tenantId: string,
    options?: { cursor?: string; limit?: number; name?: string },
  ): Promise<Page<Omit<ProcessDefinitionRow, 'diagram'>>>;
  /** Projeção iniciável {id,name,version} — escopo instances:start (etapa 5). */
  listStartable(
    tenantId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<Page<StartableDefinitionRow>>;
  lintForm(schema: FormSchema): SchemaIssue[];
  deployForm(
    tenantId: string,
    input: { formId: string; schema: FormSchema; createdBy?: string },
  ): Promise<DeployFormOutcome>;
  getFormByRef(tenantId: string, ref: string): Promise<FormDefinitionRow | undefined>;
  listForms(
    tenantId: string,
    options?: { cursor?: string; limit?: number; formId?: string },
  ): Promise<Page<Omit<FormDefinitionRow, 'schema'>>>;
}

export function createRegistry(sql: Sql, engineVersion: string): PlatformRegistry {
  return {
    lintProcess: (diagram) => lintDiagram(diagram),
    deployProcess: (tenantId, input) =>
      deployProcessDefinition(sql, tenantId, { ...input, engineVersion }),
    getProcess: (tenantId, idOrRef) => getProcessDefinition(sql, tenantId, idOrRef),
    listProcesses: (tenantId, options) => listProcessDefinitions(sql, tenantId, options),
    listStartable: (tenantId, options) => listStartableDefinitions(sql, tenantId, options),
    lintForm: (schema) => validateFormSchema(schema),
    deployForm: (tenantId, input) => deployFormDefinition(sql, tenantId, input),
    getFormByRef: (tenantId, ref) => getFormDefinitionByRef(sql, tenantId, ref),
    listForms: (tenantId, options) => listFormDefinitions(sql, tenantId, options),
  };
}

/**
 * Engine resolvido do REGISTRY (substitui as definições embutidas para refs
 * deployadas): cache por (tenant, ref) — definições são IMUTÁVEIS, o cache
 * nunca fica stale. skeleton@1/example@1 embutidas continuam válidas
 * (fixtures de teste e compat F1/F2).
 */
const registryEngines = new Map<string, Engine>();
const registryClassifications = new Map<string, Record<string, 'none' | 'personal' | 'sensitive'>>();

/**
 * Classificações DECLARADAS de uma definição deployada: união dos
 * `dataClassification` por campo dos formulários referenciados no diagrama
 * (a fonte é o schema publicado — F0b.5 tornou a declaração obrigatória).
 * É o que liga o deploy real à costura LGPD da F2 (cifra de `sensitive`).
 * O quarteto dos forms (public/internal/personal/sensitive) mapeia para o
 * trio de ARMAZENAMENTO do runtime: public/internal → 'none' (não-pessoal).
 */
export async function classificationsForRef(
  sql: Sql,
  tenantId: string,
  registryRef: string,
): Promise<Record<string, 'none' | 'personal' | 'sensitive'>> {
  const cacheKey = `${tenantId}:${registryRef}`;
  const cached = registryClassifications.get(cacheKey);
  if (cached) return cached;
  const definition = await getProcessDefinition(sql, tenantId, registryRef);
  if (!definition) return {};
  const map: Record<string, 'none' | 'personal' | 'sensitive'> = {};
  const formRefs = Object.values(definition.diagram.nodes)
    .filter((n) => n.type === 'userTask' && typeof n.properties.formRef === 'string')
    .map((n) => n.properties.formRef as string);
  for (const ref of formRefs) {
    const form = await getFormDefinitionByRef(sql, tenantId, ref);
    if (!form) continue;
    for (const field of form.schema.fields) {
      map[field.key] =
        field.dataClassification === 'sensitive'
          ? 'sensitive'
          : field.dataClassification === 'personal'
            ? 'personal'
            : 'none';
    }
  }
  registryClassifications.set(cacheKey, map);
  return map;
}

export async function engineForRef(
  sql: Sql,
  tenantId: string,
  registryRef: string,
): Promise<Engine | undefined> {
  const cacheKey = `${tenantId}:${registryRef}`;
  const cached = registryEngines.get(cacheKey);
  if (cached) return cached;
  const definition = await getProcessDefinition(sql, tenantId, registryRef);
  if (!definition) return undefined;
  const engine = createEngine(definition.diagram, { conditions: conditionEvaluator });
  registryEngines.set(cacheKey, engine);
  return engine;
}
