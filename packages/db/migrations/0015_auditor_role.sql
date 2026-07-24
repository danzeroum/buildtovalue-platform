-- Migração 0015 — papel `auditor` no RBAC [GATE-D, AG-2.3]. Forward-only.
--
-- O export de auditoria (ISO 42001 / EU AI Act) exige SEPARAÇÃO DE DEVERES: um
-- papel que LÊ a procedência e EXPORTA a trilha, mas NÃO escreve nada — nem
-- inicia, nem cancela, nem trabalha tarefa, nem revela conteúdo. O papel vive
-- no `GRANTS` do @platform/auth (só leitura + `audit:export`); aqui só abrimos
-- o CHECK de `users.role` para aceitar o novo valor. A ausência de escrita é
-- garantida pela ausência de permissão (provada no teste "auditor não escreve
-- nada"), não por trigger — a mesma disciplina de sempre: a rota declara a
-- permissão, o mapa concede, o papel não recebe.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'analyst', 'business', 'operator', 'auditor'));
