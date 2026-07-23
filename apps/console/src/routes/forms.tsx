import { useMemo, useState } from 'react';
import { FormRenderer } from '@buildtovalue/forms-react';
import {
  applyDefaults,
  formExpressionEvaluator,
  validateFormSchema,
  type DataClassification,
  type FieldType,
  type FormField,
  type FormSchema,
} from '@buildtovalue/forms';
import '@buildtovalue/forms-react/styles.css';
import { api, problemMessage } from '../api/client.js';
import { Button, Tag } from '../ui/ui.js';

const FIELD_TYPES: FieldType[] = ['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox'];

const STARTER: FormSchema = {
  formId: 'reembolso',
  version: 1,
  title: 'Reembolso — solicitação',
  fields: [
    { key: 'colaborador', label: 'Colaborador', type: 'text', dataClassification: 'personal', required: true },
    {
      key: 'valor',
      label: 'Valor (R$)',
      type: 'number',
      dataClassification: 'internal',
      required: true,
      validation: 'value > 0 and value <= 50000',
    },
    {
      key: 'justificativa',
      label: 'Justificativa',
      type: 'textarea',
      dataClassification: 'internal',
      visibleWhen: 'valor > 5000',
    },
  ],
};

/** As 4 consequências do D20 — comunicadas NO MOMENTO da escolha de 'sensível'. */
const SENSITIVE_CONSEQUENCES = [
  'cifrado em repouso (KeyProvider)',
  'mascarado por padrão',
  'fora de logs e exports',
  'não buscável por conteúdo no Operate',
];

export function FormsRoute() {
  const [schema, setSchema] = useState<FormSchema>(STARTER);
  const [selectedKey, setSelectedKey] = useState<string>(STARTER.fields[0].key);
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>(() => applyDefaults(STARTER));
  const [publishState, setPublishState] = useState<
    { kind: 'idle' } | { kind: 'ok'; ref: string } | { kind: 'error'; issues: { code: string; message: string }[] }
  >({ kind: 'idle' });

  const selected = schema.fields.find((f) => f.key === selectedKey);
  const schemaIssues = useMemo(() => validateFormSchema(schema), [schema]);

  function patchField(key: string, patch: Partial<FormField>) {
    setSchema((s) => ({
      ...s,
      fields: s.fields.map((f) => (f.key === key ? ({ ...f, ...patch } as FormField) : f)),
    }));
  }

  function addField(type: FieldType) {
    const key = `campo_${schema.fields.length + 1}`;
    const base = { key, label: 'Novo campo', type, dataClassification: 'public' as DataClassification };
    const field = (type === 'select' || type === 'radio' ? { ...base, options: [] } : base) as FormField;
    setSchema((s) => ({ ...s, fields: [...s.fields, field] }));
    setSelectedKey(key);
  }

  async function publish() {
    setPublishState({ kind: 'idle' });
    const { data, error, response } = await api.POST('/v1/form-definitions', {
      body: { formId: schema.formId, schema: schema as unknown as Record<string, never> },
    });
    if (error || !data) {
      const issues = (error as { issues?: { code: string; message: string }[] } | undefined)?.issues ?? [
        { code: `HTTP_${response.status}`, message: problemMessage(error, 'Falha ao publicar') },
      ];
      setPublishState({ kind: 'error', issues });
      return;
    }
    setPublishState({ kind: 'ok', ref: data.ref });
  }

  return (
    <section className="route forms" aria-label="Formulários">
      <div className="doc-bar">
        <div>
          <h1>{schema.title}</h1>
          <span className="draft-badge">
            rascunho · <span className="mono">{schema.formId}</span>
          </span>
        </div>
        <div className="doc-actions">
          {schemaIssues.length > 0 && (
            <span className="issues-inline" role="status">
              {schemaIssues.length} problema(s) de schema
            </span>
          )}
          <Button intent="primary" onClick={publish} disabled={schemaIssues.length > 0}>
            Publicar formulário no registry
          </Button>
        </div>
      </div>

      {publishState.kind === 'ok' && (
        <p className="publish-ok" role="status" aria-live="polite">
          Publicado como <span className="mono">{publishState.ref}</span>. Instâncias antigas seguem na versão pinada.
        </p>
      )}
      {publishState.kind === 'error' && (
        <div className="publish-error" role="alert" aria-live="assertive">
          <strong>Rejeitado pelo lint do registry:</strong>
          <ul>
            {publishState.issues.map((i, n) => (
              <li key={n}>
                <span className="mono">{i.code}</span> — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="forms-grid">
        <aside className="field-list" aria-label="Campos">
          <header>CAMPOS</header>
          <ul>
            {schema.fields.map((f) => (
              <li key={f.key}>
                <button
                  type="button"
                  className="field-item"
                  data-selected={f.key === selectedKey || undefined}
                  onClick={() => setSelectedKey(f.key)}
                >
                  <span>{f.label}</span>
                  <span className="mono type-tag">{f.type}</span>
                  {f.dataClassification === 'sensitive' && <Tag tone="sensitive">SENSÍVEL</Tag>}
                  {f.dataClassification === 'personal' && <Tag tone="personal">PESSOAL</Tag>}
                </button>
              </li>
            ))}
          </ul>
          <div className="add-palette" role="group" aria-label="Adicionar campo">
            {FIELD_TYPES.map((t) => (
              <button key={t} type="button" className="palette-pill mono" onClick={() => addField(t)}>
                {t}
              </button>
            ))}
          </div>
        </aside>

        <div className="field-props" aria-label="Propriedades do campo">
          {selected ? <FieldProperties field={selected} onChange={(p) => patchField(selected.key, p)} /> : <p>Selecione um campo.</p>}
        </div>

        <div className="form-preview" data-testid="form-preview">
          <header>PREVIEW — MESMO RENDERER DE /tasks (@buildtovalue/forms-react)</header>
          <FormRenderer
            schema={schema}
            values={previewValues}
            evaluator={formExpressionEvaluator}
            onChange={(key, value) => setPreviewValues((v) => ({ ...v, [key]: value }))}
          />
        </div>
      </div>
    </section>
  );
}

function FieldProperties({ field, onChange }: { field: FormField; onChange: (patch: Partial<FormField>) => void }) {
  const classifications: { value: DataClassification; label: string }[] = [
    { value: 'public', label: 'não pessoal' },
    { value: 'internal', label: 'interno' },
    { value: 'personal', label: 'pessoal' },
    { value: 'sensitive', label: 'sensível' },
  ];
  return (
    <div>
      <h2>PROPRIEDADES — {field.label.toUpperCase()}</h2>
      <label className="field">
        <span>Rótulo</span>
        <input value={field.label} onChange={(e) => onChange({ label: e.target.value })} />
      </label>
      <label className="field">
        <span>Chave</span>
        <input className="mono" value={field.key} readOnly aria-readonly="true" />
      </label>
      <label className="field">
        <span>
          <input
            type="checkbox"
            checked={field.required ?? false}
            onChange={(e) => onChange({ required: e.target.checked })}
          />{' '}
          Obrigatório
        </span>
      </label>
      {'validation' in field && (
        <label className="field">
          <span>Validação (S-FEEL)</span>
          <input
            className="mono"
            value={field.validation ?? ''}
            placeholder="value > 0"
            onChange={(e) => onChange({ validation: e.target.value } as Partial<FormField>)}
          />
          <small className="sfeel-legend">
            «value» = este campo; outras chaves referenciam outros campos.
          </small>
        </label>
      )}
      <fieldset className="classification" aria-label="Classificação de dados (obrigatória)">
        <legend>Classificação de dados (obrigatória)</legend>
        <div className="segmented" role="radiogroup" aria-label="Classificação">
          {classifications.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={field.dataClassification === c.value}
              className="segment"
              data-selected={field.dataClassification === c.value || undefined}
              onClick={() => onChange({ dataClassification: c.value })}
            >
              {c.label}
            </button>
          ))}
        </div>
        {field.dataClassification === 'sensitive' && (
          <div className="consequences" role="status" aria-live="polite" data-testid="sensitive-consequences">
            <strong>Consequências de marcar como sensível (D20):</strong>
            <ul>
              {SENSITIVE_CONSEQUENCES.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="mono-note">Campo que o operador precisa buscar não pode ser sensível na v1.</p>
          </div>
        )}
      </fieldset>
    </div>
  );
}
