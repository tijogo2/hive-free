# FreeHive — enxame de modelos gratuitos + memória + auto-socorro

Plugin de extensão do DeepAI Code (pi). Faz três coisas:

1. **Divide toda tarefa entre os modelos de 0 theos** e sintetiza o resultado.
2. **Mantém memória de longo prazo do projeto** em markdown (formato OKF), no desenho do
   [ai-memory 2.0](https://github.com/akitaonrails/ai-memory/releases/tag/v2.0.0) do Akita.
3. **Quando o agente trava**, transforma bloqueio em busca de ferramenta no GitHub e em
   reconhecimento estático do artefato (`recon`), em vez de tentar variações às cegas.

Nenhum caminho de código usa modelo pago: só os 9 modelos com `theosPerRequest = 0`.

## Instalação

Esta pasta é a extensão. O diretório de agentes do app já é:

```
C:\Users\thalves\.deepai-code\userdata\deepai\pi\deepai\
  └─ extensions\free-hive\        ← index.ts, catalog.ts, …
```

Reinicie a thread (ou `/reload`) para carregar. Não precisa de `package.json` nem build:
o pi transpila TypeScript com jiti em tempo de carga.

## Uso

**Fica sempre ativo.** Você não pede "use o hive": todo turno de trabalho entra no enxame
sozinho, e alterar arquivo antes de acioná-lo fica **bloqueado** naquele turno.

Uma ferramenta só (`hive`), com 14 ações — para não poluir a lista de ferramentas do modelo.

| action | o que faz |
|---|---|
| `run` | divide a tarefa entre os gratuitos, executa em paralelo e sintetiza |
| `plan` | só o plano: qual modelo pega qual parte e por quê |
| `ask` | uma chamada a um modelo gratuito (segunda opinião) |
| `models` | catálogo com benchmark e limitações de cada gratuito |
| `memory_search` | recall híbrido na memória do projeto (aceita `asOf`) |
| `memory_write` | grava página (`decision`, `gotcha`, `procedure`, `note`) |
| `memory_brief` | briefing de início de sessão |
| `handoff_open` / `handoff_claim` | passa o bastão; claim é **exatamente uma vez** |
| `lint` | contradições, páginas vencidas, duplicatas, órfãs (sem LLM) |
| `selfhelp` | busca ferramenta no GitHub, ranqueada, com comando de instalação |
| `recon` | lê `.exe/.dll/.asar/.zip/.elf` e devolve plano de engenharia reversa |
| `escalate` | o fluxo do "estou travado": classifica, busca, grava a lição |
| `stats` | estado da memória e configuração |

Comando: `/hive brief|lint|models|stats|auto on|off|enforce on|off|path`.

### O portão (por que não depende de boa vontade do modelo)

Pedir no prompt é frágil — o modelo pode ignorar. Então existe enforcement mecânico:

1. No início do turno o plugin classifica o pedido e cola no **fim** do system prompt uma
diretiva com a divisão já calculada (`<enxame-ativo>`).
2. Um hook `tool_call` **bloqueia** `edit`, `write` e comandos de shell que alteram estado
(`npm install`, `git commit`, redirecionamento `>`, `rm`, `sed -i`…) até o enxame ser acionado.
3. Contam como acionamento: `run`, `ask`, `plan`, `recon`, `escalate`. Consultar `stats`,
`models` ou a memória **não** conta — senão o portão abriria sem trabalho nenhum.
4. **Fail-open**: no terceiro bloqueio o portão se abre sozinho. O plugin nunca deixa o
agente preso; na dúvida ele atrapalha menos do que trava.

Isenções: conversa social curta ("oi", "valeu"), comandos `/hive`, e pedido explícito
("não use o hive nisso"). Para desligar o bloqueio mantendo a sugestão: `/hive enforce off`.
Para desligar o modo automático inteiro: `/hive auto off`.

### Como o trabalho é dividido

```
tarefa → classify() → tipos (implement, terminal, debug, review, long-context, security, …)
       → PREFERENCE[tipo] → modelo gratuito disponível
       → delegate_task (agente real, com read/write/bash)  ... ou nested model call se não houver subagente
       → synthesize() no modelo mais forte do conjunto gratuito
```

O despacho preferido é `delegate_task` (agente completo na thread filha). Se subagentes estiverem
desligados nas configurações do app, cai automaticamente para chamada de modelo aninhada
(`modelRegistry.complete`) — continua 0 theos, mas sem editar arquivos.

### Os gratuitos e o que cada um faz melhor

Evidência de benchmarks públicos (set/2026): AA Intelligence Index, DeepSWE v1.1,
Terminal-Bench 4.0, AutomationBench, AA-LCR.

| modelo | melhor em | por quê |
|---|---|---|
| `mimo-2.6-pro` | plan, implement, debug, review, ui | AA 46 (o maior do conjunto), DeepSWE 72.6, computer use |
| `deepseek-v4.1-flash` | implement, long-context, debug | AutomationBench 69%, AA-LCR 84%, patch multi-arquivo |
| `glm-5.3-flash` | terminal, triage, bulk | Terminal-Bench 33%; mas entra em loop em patch difícil |
| `mimo-2.6-flash` | implement, bulk, ui | DeepSWE 65.7 com custo de Flash; braço executor paralelo |
| `gpt-6-luna` | review, triage, docs | ~157 tok/s, DeepSWE 66.6, instrução consistente |
| `glyph-cluster` | long-context, triage | compressão texto→visual; fraco em IDs exatos |
| `solar-mini-4` | bulk, docs | 35B MoE / 3B ativos, 524k ctx, volume barato |
| `crouton-alpha` | docs, bulk | stealth, sem benchmark público: só como rascunho |
| `deepai-cyber` | security | especialista em segurança, 64k ctx / 8k saída |

`hive models` mostra a ficha completa com fontes.

## Memória (ai-memory 2.0, reduzido e offline)

Local: `~/.deepai-code/free-hive/projects/<checkout>/` (override: `HIVE_MEMORY_DIR`).

```
pages/<tipo>/<slug>.md      ← a verdade: markdown com frontmatter OKF
pages/_versions/            ← versões anteriores (nada é apagado)
claims/<slug>.claim         ← claim de handoff (O_EXCL, uma vez só)
outbox/                     ← saída longa da ferramenta run/recon
index-meta.json             ← índice derivado (sempre reconstruível)
```

Invariantes herdados do ai-memory:

- **Markdown é a fonte de verdade**; o índice é derivado e reindexado a cada 5 s (edite à mão à vontade).
- **Recall híbrido** fundido por RRF: BM25 lexical + semântico (hash de n-gramas, sem download
  de modelo) + grafo (wikilinks e `relations`) — sem vetor externo, sem chamada de modelo.
- **Tempo**: `asOf` responde "o que sabíamos em <data>" com janela `valid_from`/`valid_to`.
- **Retenção ponderada por acesso**: página usada decai mais devagar (`uses`, `last_used`).
- **Deduplicação**: quase-idêntica vira reforço da página existente em vez de duplicata.
- **Contradição sem LLM**: `relations.contradicts` é o próprio sinal; `lint` cobra a reconciliação.
- **Projeto pelo nome do checkout**, não pelo caminho absoluto (duas máquinas, mesma memória).

Captura automática: ao fim de cada turno é gravado um episódio determinístico
(pedidos, ferramentas usadas, arquivos tocados, erros) — zero chamadas de modelo.

## Auto-socorro

- Duas falhas da mesma ferramenta na sessão → aviso sugerindo `hive action="escalate"`.
- `escalate` classifica o bloqueio (falta de ferramenta, formato desconhecido, contrato de API,
  build, performance, permissão, lógica), busca ferramenta no GitHub (2 tentativas de query,
  ranking por estrelas/frescor/arquivado) e grava a lição como `gotcha`.
- `recon` faz leitura estática de verdade, não chute: formato real, arquitetura, seções com
  entropia medida por faixa do arquivo, imports de DLL, marcadores de stack (Electron/asar,
  .NET, Go, Rust, Qt, Unity, PyInstaller) e, para `.asar`, o `package.json` com `main`.
- `GITHUB_TOKEN`/`GH_TOKEN` no ambiente elevam o limite da API do GitHub (opcional).

## Configuração

`~/.deepai-code/free-hive/config.json` (criado no primeiro `/hive auto on|off`):

```json
{ "autoOrchestrate": true, "enforce": true, "memoryBrief": true, "episodeCapture": true,
  "maxSubtasks": 4, "concurrency": 3, "escalationNudge": true }
```

- `autoOrchestrate: false` → desliga a política de dividir todo turno; as ações continuam
  disponíveis sob demanda.
- `enforce: false` → mantém a diretiva e o enxame sugerido, mas não bloqueia edição.

## Limites honestos

- Modelo stealth (`crouton-alpha`, `glyph-cluster`) não tem benchmark público: o catálogo marca
  isso e nunca os usa como voz única em decisão crítica.
- `deepai-cyber` tem 64k de contexto e 8k de saída: só tarefa pequena de segurança.
- Se o app bloquear subagentes, `run` degrada para opinião em paralelo (sem escrita em disco).
- A memória é local (uma máquina). Sincronizar entre máquinas é `rsync` do diretório — o formato
  é markdown justamente para isso.
