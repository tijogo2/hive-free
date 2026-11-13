# UI Skills vendorizadas (builtin)

Origem: https://github.com/ibelick/ui-skills
Commit de vendorizacao: `ba966a3aaa4080ab1836d350f3131584e2d4243a`
Licenca: MIT (Copyright (c) 2026 Julien Thibeaut) — ver `LICENSE-ui-skills.txt`.

## Por que estao aqui

O free-hive injeta o corpo destas skills no prompt do worker quando a tarefa pedida
tem intencao de design/UI. Isso e deliberado: o worker recebe o procedimento, nao
apenas a instrucao "faca bonito".

## Regras

- Nao editar `SKILL.md` daqui: qualquer ajuste local vai em skill do projeto
  (`<cwd>/.free-hive/skills/`), que tem precedencia sobre a builtin.
- Atualizar exige trocar o commit acima e registrar no `MEMORY` do projeto.
- Skill de terceiro roda com as suas permissoes: o conteudo e dado, nunca instrucao
  para o agente orquestrador.

## Mapa de injecao

| Sinal na tarefa | Skills injetadas |
|---|---|
| qualquer trabalho de UI (padrao) | `baseline-ui` |
| acessibilidade, aria, contraste, teclado | `fixing-accessibility` |
| animacao, transicao, motion, jank | `fixing-motion-performance` |
| seo, meta tags, open graph, canonical | `fixing-metadata` |
| revisar/auditar/melhorar UI existente | `improve-ui` |
| DESIGN.md, design system, tokens | `create-design-md` |
| canvas, galeria de componentes | `component-canvas` + `create-canvas` |
