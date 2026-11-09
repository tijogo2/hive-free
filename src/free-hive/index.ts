/**
 * free-hive — enxame de modelos GRATUITOS (0 theos) + memoria de longo prazo + auto-socorro.
 *
 * Uma unica ferramenta `hive` (acoes) para nao poluir o conjunto de ferramentas do modelo,
 * um comando `/hive` para inspecionar estado, e hooks de sessao para:
 *   - briefing de memoria no inicio da sessao (estilo ai-memory 2.0);
 *   - captura deterministica de episodio no fim de cada turno (zero LLM);
 *   - cutucao de auto-socorro quando a mesma ferramenta falha repetido.
 *
 * Nenhum caminho aqui usa modelo pago. Nenhum hook pode derrubar a sessao: tudo em try/catch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  FREE_MODELS, HIVE_VERSION, PAID_MODELS, byId, catalogTable, classify, pickModel, shouldOrchestrate,
} from "./catalog.ts";
import { MemoryStore, PAGE_TYPES, defaultRoot, memoryStats, projectName, shortHash } from "./memory.ts";
import type { PageType } from "./memory.ts";
import { describePlan, dispatchSubtask, planTask, runPlan, synthesize } from "./orchestrator.ts";
import type { SubTask } from "./orchestrator.ts";
import { escalate, formatEscalation, formatRecon, recon, searchGithub } from "./selfhelp.ts";

const MAX_TEXT = 12_000;

interface HiveConfig {
  autoOrchestrate: boolean;
  /** bloqueia edicao ate o enxame rodar (enforcement mecanico, nao so pedido no prompt) */
  enforce: boolean;
  memoryBrief: boolean;
  episodeCapture: boolean;
  maxSubtasks: number;
  concurrency: number;
  escalationNudge: boolean;
}

const DEFAULT_CONFIG: HiveConfig = {
  autoOrchestrate: true,
  enforce: true,
  memoryBrief: true,
  episodeCapture: true,
  maxSubtasks: 4,
  concurrency: 3,
  escalationNudge: true,
};

/** Estado do portao do turno atual. */
interface TurnGuard {
  /** a tarefa do turno deve passar pelo enxame */
  active: boolean;
  /** o enxame ja foi acionado neste turno */
  hiveCalled: boolean;
  /** bloqueios aplicados no turno */
  blocks: number;
  /** liberado apos falha repetida (fail-open, nunca trava o agente) */
  waived: boolean;
  kinds: string[];
}

const WRITE_TOOLS = /^(edit|write|multi_edit|apply_patch|str_replace|notebook_edit)$/i;
// Comando de shell que altera estado em disco/repo.
const WRITE_CMD =
  /(^|[;&|]\s*)(rm|rmdir|mv|cp|mkdir|touch|tee|dd|truncate|sed\s+-i|perl\s+-i|git\s+(commit|checkout|switch|reset|apply|add|stash|merge|rebase|clean|rm|push)|npm\s+(i|ci|install|uninstall|prune|dedupe)|pnpm\s+(i|install|add|remove)|yarn\s+(add|remove)|bun\s+(add|install)|pip3?\s+install|uv\s+(add|pip)|cargo\s+(add|install)|go\s+get|dotnet\s+add|winget\s+install|scoop\s+install|choco\s+install)\b|>>?\s*[^&\s]/i;

export function isMutatingCall(toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (WRITE_TOOLS.test(toolName)) return true;
  if (/^(bash|powershell|sh|shell)$/i.test(toolName)) {
    const cmd = String((input as any)?.command ?? (input as any)?.cmd ?? "");
    return cmd ? WRITE_CMD.test(cmd) : false;
  }
  return false;
}

/**
 * Quais acoes contam como "o enxame foi acionado". Consulta a memoria, catalogo ou
 * estado NAO conta: senao o agente abre o portao com action="stats" sem trabalhar.
 */
const ENGAGING = new Set(["run", "ask", "plan", "recon", "escalate"]);

function engagesSwarm(input: unknown): boolean {
  const action = String((input as any)?.action ?? "").toLowerCase();
  return ENGAGING.has(action);
}

/** Diretiva curta colada no FIM do prompt do sistema (maior saliencia) quando o modo automatico entra. */
function autoDirective(plan: ReturnType<typeof planTask>, why: string, enforce: boolean): string {
  const divisao = plan.subtasks.map((s) => `- ${s.role} → ${s.model.id}`).join("\n");
  return [
    "",
    "<enxame-ativo>",
    "MODO ENXAME AUTOMATICO — a decisao de dividir ja foi tomada, nao precisa ser pedida.",
    `Classificacao: ${plan.kinds.join(", ")} (${why}).`,
    "Sua PRIMEIRA acao de trabalho neste turno:",
    `  hive action="run" task="<resuma a tarefa do usuario>"`,
    "Se for apenas uma pergunta (nao produz nem altera nada), use action=\"ask\" — isso tambem abre o portao.",
    "Divisao ja calculada (referencia):",
    divisao,
    enforce
      ? "Alterar arquivos (edit/write/comando de escrita) esta BLOQUEADO ate o hive rodar neste turno."
      : "Nao ha bloqueio, mas a divisao acima e o caminho esperado.",
    "Depois da sintese, verifique o que os agentes fizeram e continue a partir dali. Se o hive falhar, siga voce mesmo e diga que falhou.",
    "Isento: conversa social, pergunta curta e follow-up pontual.",
    "</enxame-ativo>",
  ].join("\n");
}

function configPath(): string {
  return path.join(defaultRoot(), "config.json");
}

function loadConfig(): HiveConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<HiveConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg: HiveConfig): void {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch { /* config e opcional */ }
}

function actorId(): string {
  return process.env.HIVE_ACTOR || shortHash(`${os.hostname()}:${process.env.PI_SESSION_ID ?? "sem-sessao"}`);
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_TEXT)}\n\n[... ${text.length - MAX_TEXT} caracteres omitidos]`, truncated: true };
}

function saveOutbox(dir: string, name: string, text: string): string | undefined {
  try {
    const out = path.join(dir, "outbox");
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.md`);
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ prompt

function hiveSystemPrompt(cfg: HiveConfig, brief: string): string {
  const linhas: string[] = [];
  linhas.push("<free-hive>");
  linhas.push(
    `FreeHive ${HIVE_VERSION} — enxame de modelos gratuitos (0 theos) + memoria OKF + auto-socorro. ` +
    "O usuario instalou este plugin para que TODA tarefa nao trivial seja dividida entre os modelos gratuitos, " +
    "para que conhecimento aprendido vire memoria do projeto, e para que bloqueio vire busca de ferramenta em vez de insistencia.",
  );
  if (cfg.autoOrchestrate) {
    linhas.push("");
    linhas.push("Politica de divisao (SEMPRE ATIVA):");
    linhas.push("- Todo turno de trabalho entra no enxame SEM o usuario precisar pedir: tarefa (implementar, depurar, varrer repo, revisar, doc longo, investigar binario/app) comeca por `hive` action=\"run\"; pergunta usa action=\"ask\".");
    linhas.push("- O portao e mecanico: alterar arquivo antes de acionar o enxame fica bloqueado neste turno. Nao e sugestao, e regra.");
    linhas.push("- Unicas saidas: conversa social curta e pedido explicito do usuario (\"nao use o hive\").");
    linhas.push("- Ao usar o enxame, diga ao usuario qual modelo pegou qual parte. O resultado final continua sendo seu: verifique antes de entregar.");
  }
  linhas.push("");
  linhas.push("Politica de memoria:");
  linhas.push("- Antes de decidir algo estrutural, `hive` action=\"memory_search\" com a pergunta. O briefing abaixo ja traz o essencial.");
  linhas.push("- Depois de uma decisao de arquitetura, um gotcha doloroso ou um procedimento que funcionou, grave: action=\"memory_write\" (type decision|gotcha|procedure|note). Escreva paginas curtas, com caminho de arquivo, erro literal e o porque.");
  linhas.push("- Se estiver saindo de um trabalho no meio, action=\"handoff_open\"; ao retomar, action=\"handoff_claim\" (reivindica uma unica vez).");
  linhas.push("- Se uma pagina contradiz outra, use relations.contradicts e resolva; `hive` action=\"lint\" mostra pendencias.");
  linhas.push("");
  linhas.push("Politica de auto-socorro:");
  linhas.push("- Se voce falhou DUAS vezes no mesmo tipo de problema, pare de tentar variacoes: chame action=\"escalate\" com o erro literal.");
  linhas.push("- Artefato sem documentacao (binario, .exe, .asar, plugin, protocolo): action=\"recon\" no arquivo ANTES de teorizar. O relatorio traz formato real, secoes, entropia e plano de REA.");
  linhas.push("- Precisa de ferramenta que nao tem: action=\"selfhelp\" (busca repo no GitHub, ranqueado por estrelas/frescor, e sugere comando de instalacao).");
  linhas.push("- Nao instale binario de origem desconhecida nem desligue protecao de seguranca: prefira gerenciador de pacote e escopo minimo.");
  linhas.push("");
  linhas.push("Modelos gratuitos disponiveis (nunca use modelo pago neste plugin):");
  linhas.push(catalogTable());
  if (brief) {
    linhas.push("");
    linhas.push("Briefing de memoria do projeto:");
    linhas.push(brief);
  }
  linhas.push("</free-hive>");
  return linhas.join("\n");
}

// -------------------------------------------------------------- parametros

const Action = Type.Union(
  [
    "run", "plan", "ask", "models", "memory_search", "memory_write", "memory_brief",
    "handoff_open", "handoff_claim", "lint", "selfhelp", "recon", "escalate", "stats",
  ].map((v) => Type.Literal(v)),
);

const Parameters = Type.Object({
  action: Action,
  task: Type.Optional(Type.String({ description: "Texto da tarefa/pergunta/bloqueio, conforme a action." })),
  model: Type.Optional(Type.String({ description: "Para action=ask: id do modelo gratuito (ex.: mimo-2.6-pro, deepseek-v4.1-flash)." })),
  kind: Type.Optional(Type.String({ description: "Para action=ask: tipo de tarefa (plan|implement|terminal|debug|review|long-context|bulk|ui|security|docs|triage|math)." })),
  title: Type.Optional(Type.String({ description: "Titulo da pagina de memoria / do handoff." })),
  body: Type.Optional(Type.String({ description: "Corpo da pagina de memoria / do handoff." })),
  type: Type.Optional(Type.String({ description: "Tipo da pagina: decision|gotcha|procedure|note|handoff|episode|model-profile." })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags da pagina." })),
  sources: Type.Optional(Type.Array(Type.String(), { description: "Fontes: URL, arquivo, id de sessao." })),
  contradicts: Type.Optional(Type.Array(Type.String(), { description: "Paginas que esta contradiz." })),
  fixes: Type.Optional(Type.Array(Type.String(), { description: "Paginas que esta corrige." })),
  supersedes: Type.Optional(Type.Array(Type.String(), { description: "Paginas que esta substitui (viram versao anterior)." })),
  query: Type.Optional(Type.String({ description: "Busca textual (memory_search) ou consulta GitHub (selfhelp)." })),
  asOf: Type.Optional(Type.String({ description: "memory_search: responde 'o que sabiamos em <data ISO>'." })),
  limit: Type.Optional(Type.Number({ description: "Limite de resultados." })),
  path: Type.Optional(Type.String({ description: "recon: caminho do arquivo/binario a analisar." })),
  evidence: Type.Optional(Type.String({ description: "escalate: erro literal, stack trace, saida do comando." })),
  language: Type.Optional(Type.String({ description: "selfhelp/escalate: filtrar repos por linguagem." })),
  maxSubtasks: Type.Optional(Type.Number({ description: "run/plan: maximo de subtarefas (1-6)." })),
  concurrency: Type.Optional(Type.Number({ description: "run: quantos agentes em paralelo (1-6)." })),
  agent: Type.Optional(Type.Boolean({ description: "ask: true despacha um agente completo (com ferramentas) em vez de uma chamada de modelo." })),
});

// ----------------------------------------------------------------- factory

export default function freeHive(pi: ExtensionAPI) {
  const cfg = loadConfig();
  let brief = "";
  let store: MemoryStore | undefined;
  let guard: TurnGuard = { active: false, hiveCalled: false, blocks: 0, waived: false, kinds: [] };
  const failureCount = new Map<string, number>();
  const nudged = new Set<string>();
  const startedAt = Date.now();

  const storeFor = (cwd: string): MemoryStore => {
    const project = projectName(cwd);
    if (store && store.project === project) return store;
    store = new MemoryStore({ project, actor: actorId() });
    store.ensure();
    return store;
  };

  // ----------------------------------------------------------- ferramenta

  pi.registerTool({
    name: "hive",
    label: "hive",
    description:
      "Enxame de modelos GRATUITOS (0 theos) com memoria de longo prazo e auto-socorro.\n" +
      "Actions:\n" +
      "- run: divide a tarefa entre os modelos gratuitos (agentes reais em paralelo) e sintetiza o resultado.\n" +
      "- plan: so o plano de divisao (qual modelo pega o que e por que).\n" +
      "- ask: uma chamada a um modelo gratuito (segunda opiniao rapida; agent=true para agente completo).\n" +
      "- models: catalogo dos gratuitos com forcas/limitacoes e benchmarks.\n" +
      "- memory_search / memory_write / memory_brief / handoff_open / handoff_claim / lint: memoria OKF do projeto (markdown em disco, recall hibrido, as_of, versionamento).\n" +
      "- selfhelp: procura no GitHub ferramenta que resolve o bloqueio (ranqueada, com comando de instalacao).\n" +
      "- recon: leitura estatica de .exe/.dll/.asar/app: formato, secoes, entropia, imports, stack e plano de engenharia reversa.\n" +
      "- escalate: o fluxo do 'estou travado' — classifica o bloqueio, busca ferramenta, grava a licao na memoria.\n" +
      "- stats: estado da memoria e configuracao.",
    promptSnippet: "hive: divide tarefas entre modelos gratuitos, guarda memoria do projeto e busca ferramenta quando trava",
    promptGuidelines: [
      "Use `hive` com action=\"run\" para tarefas nao triviais: o trabalho e dividido entre modelos gratuitos e sintetizado.",
      "Use `hive` action=\"memory_search\" antes de decisoes estruturais e action=\"memory_write\" depois de decisoes/gotchas.",
      "Se falhar duas vezes no mesmo problema, use `hive` action=\"escalate\" (e action=\"recon\" para artefato sem documentacao) em vez de tentar variacoes.",
    ],
    parameters: Parameters,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as Record<string, any>;
      const action = String(p.action ?? "");
      const st = storeFor(ctx.cwd ?? process.cwd());
      const cwd = ctx.cwd ?? process.cwd();
      const progress = (msg: string) => onUpdate?.({ content: [{ type: "text", text: msg }], details: undefined });

      try {
        switch (action) {
          // ---------------------------------------------------------- modelos
          case "models": {
            const linhas = FREE_MODELS.map((m) => {
              const meta = [
                m.aa ? `AA ${m.aa}` : "AA n/d",
                m.deepswe ? `DeepSWE ${m.deepswe}` : "DeepSWE n/d",
                `${Math.round(m.ctx / 1024)}k ctx / ${Math.round(m.maxOut / 1024)}k out`,
                m.textOnly ? "text-only" : "multimodal",
                "0 theos",
              ].join(" · ");
              return [
                `## ${m.name} (\`${m.id}\`) — ${m.vendor}`,
                meta,
                `Melhor em: ${m.bestFor.join(", ")}`,
                "Forcas:",
                ...m.strengths.map((s) => `- ${s}`),
                "Cuidados:",
                ...m.cautions.map((s) => `- ${s}`),
                `Fontes: ${m.sources.join(" | ")}`,
              ].join("\n");
            });
            const pagos = Object.entries(PAID_MODELS).map(([k, v]) => `${k} (${v} theos)`).join(", ");
            return {
              content: [{ type: "text", text: `${linhas.join("\n\n")}\n\nBloqueados por custo: ${pagos}` }],
              details: { action, models: FREE_MODELS.length },
            };
          }

          // ------------------------------------------------------------- plano
          case "plan": {
            const task = String(p.task ?? "").trim();
            if (!task) throw new Error("action=plan exige `task`");
            const plan = planTask(task, { maxSubtasks: p.maxSubtasks, allowPaid: false });
            return {
              content: [{ type: "text", text: describePlan(plan) }],
              details: { action, kinds: plan.kinds, subtasks: plan.subtasks.map((s) => ({ id: s.id, role: s.role, model: s.model.id })) },
            };
          }

          // --------------------------------------------------------------- ask
          case "ask": {
            const question = String(p.task ?? p.query ?? "").trim();
            if (!question) throw new Error("action=ask exige `task`");
            const kind = (p.kind as SubTask["kind"]) ?? classify(question).kinds[0];
            const explicit = p.model ? byId(String(p.model)) : undefined;
            if (p.model && !explicit) {
              throw new Error(`modelo "${p.model}" nao e gratuito ou nao existe. Gratuitos: ${FREE_MODELS.map((m) => m.id).join(", ")}`);
            }
            const model = explicit ?? pickModel(kind, { needsVision: /screenshot|imagem/i.test(question) })!;
            const sub: SubTask = {
              id: "ask",
              role: kind,
              kind,
              model,
              title: `ask: ${question.slice(0, 60)}`,
              prompt: question,
              rationale: "pedido direto",
              dependsOn: [],
            };
            progress(`${model.name} respondendo...`);
            // ask = uma chamada de modelo. Só vira agente completo (com ferramentas) se
            // o chamador pedir agent=true — senão uma pergunta simples abriria uma thread filha.
            const asAgent = p.agent === true;
            const r = await dispatchSubtask(sub, {
              ctx: {
                tools: ctx.tools as any,
                modelRegistry: ctx.modelRegistry as any,
                executeTool: asAgent && ctx.executeTool ? (n, a, o) => ctx.executeTool(n, a, o) : undefined,
                signal,
              },
              timeoutMs: 300_000,
            });
            const body = r.ok ? r.output : `falhou (${r.via}): ${r.error ?? "sem detalhe"}`;
            const t = truncate(body);
            return {
              content: [{ type: "text", text: `${t.text}\n\n---\nmodelo: ${model.name} (${model.id}, 0 theos) · via ${r.via} · ${Math.round(r.durationMs / 1000)}s` }],
              details: { action, model: model.id, ok: r.ok, via: r.via },
              ...(r.ok ? {} : { isError: true }),
            };
          }

          // --------------------------------------------------------------- run
          case "run": {
            const task = String(p.task ?? "").trim();
            if (!task) throw new Error("action=run exige `task`");
            const plan = planTask(task, {
              maxSubtasks: p.maxSubtasks ?? cfg.maxSubtasks,
              allowPaid: false,
            });
            progress(`plano: ${plan.subtasks.map((s) => `${s.role}->${s.model.id}`).join(", ")}`);
            const results = await runPlan(plan, {
              ctx: { tools: ctx.tools as any, modelRegistry: ctx.modelRegistry as any, executeTool: ctx.executeTool ? (n, a, o) => ctx.executeTool(n, a, o) : undefined, signal },
              concurrency: p.concurrency ?? cfg.concurrency,
              onUpdate: progress,
            } as any);
            progress("sintetizando...");
            const synth = await synthesize(plan, results, {
              ctx: { tools: ctx.tools as any, modelRegistry: ctx.modelRegistry as any, executeTool: ctx.executeTool ? (n, a, o) => ctx.executeTool(n, a, o) : undefined, signal },
            } as any);

            const cabec = [
              "## Divisao executada",
              ...plan.subtasks.map((s) => `- ${s.id} [${s.role}] ${s.model.name} (${s.model.id})`),
              "",
              "## Resultado por agente",
              ...results.map((r) => `- ${r.id} ${r.ok ? "ok" : "FALHOU"} · ${r.model} · ${r.via} · ${Math.round(r.durationMs / 1000)}s${r.taskId ? ` · taskId ${r.taskId}` : ""}${r.error ? ` · ${r.error}` : ""}`),
            ].join("\n");
            const finalText = `${cabec}\n\n## Sintese\n${synth.text}\n\n---\nsintese: ${synth.via} · 0 theos · ${Math.round((Date.now() - startedAt) / 1000)}s de sessao`;
            const t = truncate(finalText);
            const file = t.truncated ? saveOutbox(st.dir, "run", finalText) : undefined;
            if (file) {
              return {
                content: [{ type: "text", text: `${t.text}\n\n[saida completa: ${file}]` }],
                details: { action, plan: plan.kinds, results: results.map((r) => ({ id: r.id, model: r.model, ok: r.ok, via: r.via })), file },
              };
            }
            return {
              content: [{ type: "text", text: t.text }],
              details: { action, plan: plan.kinds, results: results.map((r) => ({ id: r.id, model: r.model, ok: r.ok, via: r.via })) },
            };
          }

          // ------------------------------------------------------------ memoria
          case "memory_search": {
            const q = String(p.query ?? p.task ?? "").trim();
            if (!q) throw new Error("action=memory_search exige `query`");
            const hits = st.query(q, { asOf: p.asOf, limit: p.limit ?? 8, includeStale: true });
            st.markUsed(hits.map((h) => h.rel));
            if (!hits.length) {
              return { content: [{ type: "text", text: `Nada na memoria de "${st.project}" para: ${q}` }], details: { action, hits: 0 } };
            }
            const L = [`# Memoria de ${st.project} — ${hits.length} resultado(s)${p.asOf ? ` (as_of ${p.asOf})` : ""}`];
            for (const h of hits) {
              L.push(`\n## [${h.rel}] ${h.title}${h.stale ? " (VENCIDA)" : ""}`);
              L.push(`tipo ${h.type} · score ${h.score.toFixed(3)} · usos ${h.uses}`);
              L.push(h.snippet);
            }
            return { content: [{ type: "text", text: L.join("\n") }], details: { action, hits: hits.length } };
          }

          case "memory_write": {
            const title = String(p.title ?? "").trim();
            const body = String(p.body ?? p.task ?? "").trim();
            if (!title || !body) throw new Error("action=memory_write exige `title` e `body`");
            const type = (PAGE_TYPES.includes(p.type) ? p.type : "note") as PageType;
            const { page, action: what } = await st.write({
              type,
              title,
              body,
              tags: p.tags,
              sources: p.sources ?? [`sessao:${process.env.PI_SESSION_ID ?? "?"}`],
              relations: { contradicts: p.contradicts, fixes: p.fixes, supersedes: p.supersedes },
            });
            const msg = {
              created: `pagina criada: ${page.rel}`,
              merged: `ja existia pagina equivalente, reforcada: ${page.rel} (usos=${page.uses})`,
              superseded: `pagina criada: ${page.rel} (anteriores versionadas em _versions/)`,
            }[what];
            return { content: [{ type: "text", text: msg }], details: { action, rel: page.rel, result: what } };
          }

          case "memory_brief": {
            return { content: [{ type: "text", text: st.brief(p.limit ?? 10) }], details: { action } };
          }

          case "handoff_open": {
            const title = String(p.title ?? "").trim();
            const body = String(p.body ?? p.task ?? "").trim();
            if (!title || !body) throw new Error("action=handoff_open exige `title` e `body`");
            const page = await st.handoffOpen({ title, body, tags: p.tags });
            return {
              content: [{ type: "text", text: `handoff aberto: ${page.rel} (dono: ${page.owner})` }],
              details: { action, rel: page.rel },
            };
          }

          case "handoff_claim": {
            const needle = String(p.title ?? p.query ?? "").trim();
            if (!needle) throw new Error("action=handoff_claim exige `title` (titulo ou caminho do handoff)");
            const r = st.claimHandoff(needle, actorId());
            if (!r.ok) {
              return { content: [{ type: "text", text: `nao reivindicado: ${r.reason}` }], details: { action, ok: false }, isError: true };
            }
            return {
              content: [{ type: "text", text: `handoff reivindicado: ${r.page!.rel}\n\n${r.page!.body}` }],
              details: { action, rel: r.page!.rel, ok: true },
            };
          }

          case "lint": {
            const findings = st.lint();
            return { content: [{ type: "text", text: findings.join("\n") }], details: { action, findings: findings.length } };
          }

          // ----------------------------------------------------- auto-socorro
          case "selfhelp": {
            const q = String(p.query ?? p.task ?? "").trim();
            if (!q) throw new Error("action=selfhelp exige `query`");
            const repos = await searchGithub(q, { limit: p.limit ?? 5, language: p.language, signal });
            if (!repos.length) return { content: [{ type: "text", text: `nenhum repo encontrado para: ${q}` }], details: { action, results: 0 } };
            const L = [`# GitHub — ${q}`];
            for (const r of repos) {
              L.push(`\n## ${r.fullName} ★${r.stars} · ${r.language ?? "?"} · ${r.updated}${r.archived ? " · ARQUIVADO" : ""}`);
              L.push(r.description || "(sem descricao)");
              L.push(r.url);
              if (r.install) L.push(`instalar: ${r.install}`);
            }
            L.push("\nAvalie antes de instalar: licenca, ultimo commit, issues abertas criticas. Prefira gerenciador de pacote.");
            return { content: [{ type: "text", text: L.join("\n") }], details: { action, results: repos.length } };
          }

          case "recon": {
            const target = String(p.path ?? p.task ?? "").trim();
            if (!target) throw new Error("action=recon exige `path`");
            const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
            const report = recon(abs);
            const text = formatRecon(report);
            const t = truncate(text);
            const file = t.truncated ? saveOutbox(st.dir, "recon", text) : undefined;
            return {
              content: [{ type: "text", text: file ? `${t.text}\n\n[relatorio completo: ${file}]` : t.text }],
              details: { action, format: report.format, arch: report.arch, markers: report.markers, sections: report.sections.length },
            };
          }

          case "escalate": {
            const blocker = String(p.task ?? p.query ?? "").trim();
            if (!blocker) throw new Error("action=escalate exige `task` descrevendo o bloqueio");
            progress("classificando bloqueio e buscando ferramenta...");
            const e = await escalate(blocker, { evidence: p.evidence, language: p.language, signal });
            const { page } = await st.write({
              type: "gotcha",
              title: e.memoryPage!.title,
              body: `${e.memoryPage!.body}\n\nPagina gerada automaticamente pelo FreeHive (escalate).`,
              tags: ["auto-socorro", e.classification],
              sources: [`sessao:${process.env.PI_SESSION_ID ?? "?"}`],
            });
            const text = `${formatEscalation(e)}\n\nlicao gravada na memoria: ${page.rel}`;
            return { content: [{ type: "text", text }], details: { action, classification: e.classification, rel: page.rel, candidates: e.candidates.length } };
          }

          case "stats": {
            const text = [
              `FreeHive ${HIVE_VERSION} · ator ${actorId()}`,
              `projeto: ${st.project} · cwd: ${cwd}`,
              memoryStats(st),
              `modo automatico: divisao ${cfg.autoOrchestrate ? "ON" : "OFF"} · bloqueio ate o enxame ${cfg.enforce ? "ON" : "OFF"}`,
              `portao deste turno: ${guard.active ? (guard.hiveCalled ? "enxame ja rodou (aberto)" : guard.waived ? "liberado por falha repetida" : `fechado (${guard.blocks} bloqueio(s))`) : "inativo neste turno"}`,
              `config: ${JSON.stringify(cfg)} em ${configPath()}`,
              `falhas por ferramenta nesta sessao: ${failureCount.size ? [...failureCount].map(([k, v]) => `${k}=${v}`).join(" ") : "nenhuma"}`,
            ].join("\n");
            return { content: [{ type: "text", text }], details: { action } };
          }

          default:
            throw new Error(`action desconhecida: ${action}`);
        }
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        return { content: [{ type: "text", text: `hive ${action}: ${message}` }], details: { action, error: message }, isError: true };
      }
    },
  });

  // -------------------------------------------------------------- comando

  pi.registerCommand("hive", {
    description: "FreeHive: brief | lint | models | stats | auto on/off | path",
    handler: async (arg, ctx) => {
      const [sub, ...rest] = String(arg ?? "").trim().split(/\s+/);
      const st = storeFor(ctx.cwd ?? process.cwd());
      const say = (t: string) => ctx.ui.notify(t, "info");
      try {
        switch (sub) {
          case "brief": say(st.brief(12)); break;
          case "lint": say(st.lint().join("\n")); break;
          case "models": say(FREE_MODELS.map((m) => `${m.id} — ${m.bestFor.join("/")}`).join("\n")); break;
          case "path": say(st.dir); break;
          case "auto": {
            const val = (rest[0] ?? "").toLowerCase();
            if (val !== "on" && val !== "off") { say(`auto esta ${cfg.autoOrchestrate ? "on" : "off"} (use /hive auto on|off)`); break; }
            cfg.autoOrchestrate = val === "on";
            saveConfig(cfg);
            say(`divisao automatica: ${val}`);
            break;
          }
          case "enforce": {
            const val = (rest[0] ?? "").toLowerCase();
            if (val !== "on" && val !== "off") { say(`bloqueio esta ${cfg.enforce ? "on" : "off"} (use /hive enforce on|off)`); break; }
            cfg.enforce = val === "on";
            saveConfig(cfg);
            say(val === "on"
              ? "bloqueio ligado: edicao espera o enxame rodar no turno"
              : "bloqueio desligado: o enxame e sugerido, mas nao impede edicao");
            break;
          }
          default: say("FreeHive: /hive brief|lint|models|stats|auto on|off|enforce on|off|path");
        }
      } catch (error) {
        ctx.ui.notify(`hive: ${(error as Error)?.message ?? error}`, "error");
      }
    },
  });

  // --------------------------------------------------------------- hooks

  pi.on("session_start", async (_event, ctx) => {
    try {
      const st = storeFor(ctx.cwd ?? process.cwd());
      if (cfg.memoryBrief) {
        brief = st.brief(10);
        const vivas = st.all().filter((p) => !p.validTo).length;
        if (vivas > 0) ctx.ui.notify(`FreeHive: ${vivas} paginas de memoria carregadas (${st.project})`, "info");
      }
    } catch (error) {
      ctx.ui.notify(`FreeHive memoria indisponivel: ${(error as Error)?.message ?? error}`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    try {
      const extra = hiveSystemPrompt(cfg, brief);
      // Todo turno novo comeca sem enxame rodado. O portao e rearmado aqui.
      guard = { active: false, hiveCalled: false, blocks: 0, waived: false, kinds: [] };
      let auto = "";
      const prompt = event.messageType === "user" ? String(event.prompt ?? "") : "";
      if (cfg.autoOrchestrate && prompt && !prompt.startsWith("/")) {
        const decisao = shouldOrchestrate(prompt);
        if (decisao.yes) {
          const plan = planTask(prompt, { maxSubtasks: cfg.maxSubtasks, allowPaid: false });
          guard = { active: cfg.enforce, hiveCalled: false, blocks: 0, waived: false, kinds: plan.kinds };
          auto = autoDirective(plan, decisao.why, cfg.enforce);
        }
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${extra}${auto}` };
    } catch {
      return undefined;
    }
  });

  // Enforcement: ate o enxame rodar neste turno, alteracao de arquivo/estado fica bloqueada.
  pi.on("tool_call", (event, ctx) => {
    try {
      const name = String((event as any).toolName ?? "");
      if (name === "hive") {
        if (guard.active && engagesSwarm((event as any).input)) guard.hiveCalled = true;
        return undefined;
      }
      if (!guard.active || guard.hiveCalled || guard.waived) return undefined;
      if (!isMutatingCall(name, (event as any).input)) return undefined;
      guard.blocks += 1;
      if (guard.blocks > 2) {
        // fail-open: depois de insistir, libera — o plugin nunca pode travar o agente
        guard.waived = true;
        return undefined;
      }
      ctx.ui.notify("FreeHive: edicao bloqueada ate o enxame rodar neste turno", "warning");
      return {
        block: true,
        reason:
          `FreeHive esta ativo e a tarefa foi classificada como ${guard.kinds.join("/")}. ` +
          `Antes de alterar arquivos, chame a ferramenta hive com action="run" e task resumindo o pedido. ` +
          `Se o enxame nao for util, chame action="stats" e siga — o bloqueio libera sozinho depois de novas tentativas.`,
      };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      // O enxame rodou? Marca para abrir o portao. Se falhou, libera de vez.
      const chamada = String((event as any).toolName ?? "");
      if (chamada === "hive" && engagesSwarm((event as any).input)) {
        guard.hiveCalled = true;
        if (event.isError) guard.waived = true;
      }
      if (!event?.isError) return;
      const name = String((event as any).toolName ?? (event as any).name ?? "tool");
      const n = (failureCount.get(name) ?? 0) + 1;
      failureCount.set(name, n);
      if (cfg.escalationNudge && n >= 2 && !nudged.has(name)) {
        nudged.add(name);
        ctx.ui.notify(
          `FreeHive: "${name}" falhou ${n}x. Em vez de outra variacao, use hive action="escalate" (ou action="recon" se for binario/app sem documentacao).`,
          "warning",
        );
      }
    } catch { /* hook nunca derruba sessao */ }
  });

  pi.on("agent_end", (event, ctx) => {
    try {
      if (!cfg.episodeCapture) return;
      captureEpisode(storeFor(ctx.cwd ?? process.cwd()), event as any, failureCount);
    } catch { /* captura e best-effort */ }
  });
}

// ------------------------------------------------------------ captura

/** Episodio deterministico: o que foi pedido, o que foi tocado, o que falhou. Zero LLM. */
function captureEpisode(store: MemoryStore, event: { messages?: any[] }, failures: Map<string, number>): void {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  if (messages.length < 2) return;

  const prompts: string[] = [];
  const tools = new Map<string, number>();
  const files = new Set<string>();
  const errors: string[] = [];

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = m.content;
    if (m.role === "user") {
      const text = typeof content === "string"
        ? content
        : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ") : "";
      if (text && !text.startsWith("<free-hive>")) prompts.push(text);
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "toolCall" || part.type === "tool_call") {
          const name = String(part.name ?? part.toolName ?? "?");
          tools.set(name, (tools.get(name) ?? 0) + 1);
          const args = part.arguments ?? part.input ?? {};
          const p = args?.path ?? args?.file_path ?? args?.filePath;
          if (typeof p === "string" && p) files.add(p);
        }
        if (part.type === "text" && part.text && /error|erro|failed|falhou/i.test(String(part.text).slice(0, 400)) && m.role === "toolResult") {
          errors.push(String(part.text).slice(0, 300));
        }
      }
    }
    if (m.role === "toolResult" && m.isError) {
      errors.push(`${m.toolName ?? "tool"}: ${JSON.stringify(m.content ?? "").slice(0, 200)}`);
    }
  }

  if (!prompts.length) return;
  const first = prompts[0].replace(/\s+/g, " ").slice(0, 90);
  const quando = new Date().toISOString().slice(0, 16).replace("T", " ");
  const tr = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const body = [
    `Sessao de ${quando}.`,
    "",
    "## Pedidos",
    ...prompts.slice(0, 8).map((p) => `- ${p.replace(/\s+/g, " ").slice(0, 200)}`),
    "",
    "## Ferramentas usadas",
    tr.length ? tr.map(([k, v]) => `- ${k}: ${v}`).join("\n") : "- (nenhuma)",
    "",
    "## Arquivos tocados",
    files.size ? [...files].slice(0, 25).map((f) => `- ${f}`).join("\n") : "- (nenhum)",
    errors.length ? `\n## Erros vistos\n${[...new Set(errors)].slice(0, 8).map((e) => `- ${e}`).join("\n")}` : "",
    failures.size ? `\n## Ferramentas que falharam repetido\n${[...failures].map(([k, v]) => `- ${k}: ${v}`).join("\n")}` : "",
    "",
    `sessao: ${process.env.PI_SESSION_ID ?? "?"}`,
  ].filter(Boolean).join("\n");

  void store.write(
    {
      type: "episode",
      title: `Sessao ${quando} — ${first}`,
      body,
      tags: ["episodio", ...tr.slice(0, 3).map(([k]) => k)],
      sources: [`sessao:${process.env.PI_SESSION_ID ?? "?"}`],
    },
    { dedupe: false },
  );
}
