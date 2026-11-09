/**
 * free-hive / orchestrator.ts
 *
 * Divide uma tarefa entre os modelos GRATUITOS (0 theos) e junta o resultado.
 *
 * Dois modos de despacho, nesta ordem de preferencia:
 *
 *  A) delegate_task (MCP do DeepAI Code): cada subtarefa vira um agente de verdade,
 *     com read/write/bash, rodando na thread filha. Continua custando 0 theos porque
 *     o modelo alvo e um dos gratuitos. E o modo que "trabalha", nao apenas opina.
 *  B) modelRegistry.complete(): chamada de modelo aninhada, sem ferramentas. Fallback
 *     quando o app nao expoe delegate_task (subagentes desligados, provider sem auth).
 *
 * Nada aqui escolhe modelo pago: `allowPaid` precisa ser true e mesmo assim o valor
 * e recusado — a lista paga serve apenas para explicar o bloqueio.
 */

import type { FreeModel, TaskKind } from "./catalog.ts";
import { FREE_MODELS, byId, classify, pickModel, PREFERENCE } from "./catalog.ts";

export interface SubTask {
  id: string;
  role: string;
  kind: TaskKind;
  model: FreeModel;
  title: string;
  prompt: string;
  /** porque este modelo foi escolhido */
  rationale: string;
  dependsOn: string[];
}

export interface Plan {
  task: string;
  kinds: TaskKind[];
  reason: string[];
  subtasks: SubTask[];
  /** modelo que faz a sintese final */
  synthesizer: FreeModel;
  notes: string[];
}

export interface DispatchResult {
  id: string;
  role: string;
  model: string;
  ok: boolean;
  output: string;
  via: "delegate_task" | "nested-model" | "none";
  error?: string;
  durationMs: number;
  taskId?: string;
}

// O agente despachado roda com o mesmo plugin carregado. Sem esta trava ele poderia
// chamar hive action="run" de novo e abrir um enxame dentro do enxame.
const STARTER = [
  "Voce e um agente do enxame gratuito do FreeHive. Trabalhe apenas na sua parte.",
  "NAO chame a ferramenta hive com action=run nem action=plan: voce e um worker, nao o orquestrador.",
  "Nao delegue para outros agentes. Entregue o resultado da sua parte e pare.",
].join("\n");

const ROLE_BRIEF: Record<string, string> = {
  plan: "Produza o plano de execucao: passos numerados, arquivos a tocar, riscos e criterio de pronto. Nao escreva codigo de producao.",
  implement: "Implemente a mudanca. Edite arquivos reais, siga o estilo do projeto, rode o build/teste quando existir. Reporte arquivos alterados e o que validou.",
  terminal: "Resolva a parte de CLI/ambiente: comandos exatos, ordem, o que verificar em cada passo, e o que fazer se falhar.",
  debug: "Encontre a causa raiz. Formule hipoteses, colete evidencia, aponte a linha e a correcao minima. Diga o que descartou e por que.",
  review: "Revise criticamente o que foi produzido. Liste defeitos concretos (arquivo:linha), risco e correcao. Nao reescreva o projeto inteiro.",
  "long-context": "Leia a entrada grande e devolva apenas o que importa: mapa do que existe, pontos relevantes com localizacao, e o que pode ser ignorado.",
  bulk: "Execute a varredura/transformacao em volume. Seja mecanico e consistente. Devolva a lista de itens tratados e as excecoes.",
  ui: "Trabalhe a parte de interface/computer use: descreva o estado da tela, os elementos e a sequencia de acoes.",
  security: "Analise sob a otica de seguranca: superficie, achado, severidade, prova minima e mitigacao. Sem especulacao sem evidencia.",
  docs: "Escreva o texto final em portugues do Brasil, claro e direto, sem encher linguagem.",
  triage: "Classifique os itens em categorias e devolva uma tabela compacta. Sem comentario extra.",
  math: "Resolva com raciocinio explicito e verifique o resultado por um segundo caminho.",
};

function newId(prefix: string, n: number): string {
  return `${prefix}${n}`;
}

/**
 * Planeja a divisao. Deterministico por padrao (custo zero de modelo); o modelo
 * so entra se `refine` for pedido, usando o mais forte do conjunto gratuito.
 */
export function planTask(task: string, opts: { maxSubtasks?: number; allowPaid?: boolean; inputTokens?: number } = {}): Plan {
  const cls = classify(task, opts.inputTokens ?? 0);
  const max = Math.max(1, Math.min(opts.maxSubtasks ?? 4, 6));
  const kinds = cls.kinds.filter((k) => k !== "triage" || cls.kinds.length === 1);
  const notes: string[] = [];

  // ordem canonica de execucao: planejar -> implementar/terminal/debug -> revisar
  const ORDER: TaskKind[] = ["plan", "long-context", "debug", "terminal", "implement", "bulk", "ui", "security", "math", "docs", "triage", "review"];
  const ordered = [...kinds].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).slice(0, max);

  const used: string[] = [];
  const subtasks: SubTask[] = ordered.map((kind, i) => {
    const model = pickModel(kind, { needsVision: cls.needsVision }) ?? FREE_MODELS[0];
    used.push(model.id);
    const rationale = `${kind} -> ${model.id}` +
      (model.bestFor.includes(kind) ? "" : " (fallback: nenhum especialista livre disponivel)");
    return {
      id: newId("st", i + 1),
      role: kind,
      kind,
      model,
      title: `${kind}: ${task.slice(0, 70)}`,
      prompt: [
        ROLE_BRIEF[kind] ?? ROLE_BRIEF.implement,
        "",
        "TAREFA ORIGINAL DO USUARIO:",
        task,
        "",
        cls.reason.length ? `SINAIS DETECTADOS: ${cls.reason.join("; ")}` : "",
        "Responda apenas com o resultado da sua parte, em portugues do Brasil, sem preambulo.",
      ].filter(Boolean).join("\n"),
      rationale,
      dependsOn: kind === "review" ? ["*"] : [],
    };
  });

  const synthesizer =
    byId("mimo-2.6-pro") ?? FREE_MODELS[0];
  if (classify(task).kinds.includes("security")) {
    notes.push("Tarefa envolve seguranca: a revisao de seguranca usa o DeepAI Cyber (64k ctx, saida 8k).");
  }
  if (opts.allowPaid) notes.push("allowPaid=true ignorado: o FreeHive so despacha modelos de 0 theos.");
  notes.push(`sintese final por ${synthesizer.id}`);

  return { task, kinds, reason: cls.reason, subtasks, synthesizer, notes };
}

// ------------------------------------------------------------------ despacho

interface CallCtx {
  tools?: readonly { name: string }[];
  modelRegistry?: {
    find(provider: string, modelId: string): unknown;
    getAvailable?(): readonly unknown[];
    complete(model: unknown, context: unknown, options?: unknown): Promise<unknown>;
  };
  executeTool?: (name: string, args: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  signal?: AbortSignal;
}

/** acha o nome real do delegate_task no conjunto de ferramentas callable */
export function findDelegateTool(ctx: CallCtx): string | undefined {
  const names = (ctx.tools ?? []).map((t) => t.name);
  return (
    names.find((n) => /(^|__)delegate_task$/.test(n)) ??
    names.find((n) => n.endsWith("delegate_task"))
  );
}

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  if (!r?.content) return "";
  return r.content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
}

/** extrai taskId de respostas async do delegate_task */
function taskIdOf(result: unknown): string | undefined {
  const r = result as Record<string, any> | undefined;
  const direct = r?.taskId ?? r?.task_id ?? r?.structuredContent?.taskId;
  if (typeof direct === "string") return direct;
  const txt = textOf(result);
  const m = txt.match(/"?taskId"?\s*[:=]\s*"([^"]+)"/) ?? txt.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/);
  return m?.[1];
}

export interface DispatchOptions {
  ctx: CallCtx;
  /** modelo do provider usado nos nested calls (default deepai) */
  provider?: string;
  /** orcamento por subtarefa quando o despacho e sincrono */
  timeoutMs?: number;
  onUpdate?: (msg: string) => void;
}

/** A) agente completo via delegate_task */
async function viaDelegate(ctx: CallCtx, name: string, sub: SubTask, timeoutMs: number): Promise<DispatchResult> {
  const started = Date.now();
  const res = (await ctx.executeTool!(name, {
    task: `${STARTER}\n\n${sub.prompt}`,
    title: sub.title.slice(0, 90),
    role: sub.role === "implement" ? "implementation" : sub.role === "review" ? "review" : "general",
    target: { providerInstanceId: "deepai", model: sub.model.slug },
    mode: "wait",
    timeoutMs,
    clientRequestId: `freehive-${sub.id}-${sub.model.id}-${started}`,
  }, { signal: ctx.signal })) as Record<string, any>;

  const isError = Boolean(res?.isError);
  const text = textOf(res);
  const timedOut = Boolean(res?.structuredContent?.waitTimedOut ?? res?.waitTimedOut);
  return {
    id: sub.id,
    role: sub.role,
    model: sub.model.id,
    ok: !isError,
    output: text || (isError ? `erro: ${text || "sem detalhe"}` : "(sem saida)"),
    via: "delegate_task",
    error: isError ? text || "delegate_task falhou" : undefined,
    durationMs: Date.now() - started,
    taskId: taskIdOf(res),
    ...(timedOut ? { error: "tempo esgotado (agente pode continuar; use task_status)" } : {}),
  };
}

/** B) chamada de modelo aninhada, sem ferramentas */
async function viaNestedModel(ctx: CallCtx, provider: string, sub: SubTask): Promise<DispatchResult> {
  const started = Date.now();
  const reg = ctx.modelRegistry;
  if (!reg) throw new Error("modelRegistry indisponivel");
  let model = reg.find(provider, sub.model.id) ?? reg.find(provider, sub.model.slug);
  if (!model && reg.getAvailable) {
    model = (reg.getAvailable() as Array<{ provider?: string; id?: string }>).find(
      (m) => (m.provider === provider || String(m.provider).includes(provider)) && String(m.id).replace(/^deepai\//, "") === sub.model.id,
    );
  }
  if (!model) throw new Error(`modelo ${sub.model.slug} nao encontrado no registry`);
  const message = await reg.complete(model, {
    systemPrompt: STARTER,
    messages: [{ role: "user", content: sub.prompt, timestamp: Date.now() }],
  });
  const content = (message as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  const text = content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trim();
  const stopReason = (message as { stopReason?: string })?.stopReason;
  return {
    id: sub.id,
    role: sub.role,
    model: sub.model.id,
    ok: Boolean(text) && stopReason !== "error",
    output: text || "(sem saida)",
    via: "nested-model",
    error: stopReason === "error" ? "provider retornou erro" : undefined,
    durationMs: Date.now() - started,
  };
}

/** despacha uma subtarefa, preferindo agente completo */
export async function dispatchSubtask(sub: SubTask, opts: DispatchOptions): Promise<DispatchResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const provider = opts.provider ?? "deepai";
  const delegate = opts.ctx.executeTool ? findDelegateTool(opts.ctx) : undefined;
  if (delegate) {
    try {
      const r = await viaDelegate(opts.ctx, delegate, sub, timeoutMs);
      if (r.ok && r.output) return r;
      opts.onUpdate?.(`${sub.id}: delegate_task sem resultado util (${r.error ?? "vazio"}); tentando modelo direto`);
      const fallback = await viaNestedModel(opts.ctx, provider, sub).catch((e) => ({
        id: sub.id, role: sub.role, model: sub.model.id, ok: false, output: "",
        via: "none" as const, error: String(e), durationMs: 0,
      }));
      return fallback.ok ? fallback : r;
    } catch (error) {
      opts.onUpdate?.(`${sub.id}: delegate_task falhou (${String(error)}); tentando modelo direto`);
    }
  }
  try {
    return await viaNestedModel(opts.ctx, provider, sub);
  } catch (error) {
    return {
      id: sub.id, role: sub.role, model: sub.model.id, ok: false, output: "",
      via: "none", error: String((error as Error)?.message ?? error), durationMs: 0,
    };
  }
}

/** executa o plano com concorrencia limitada */
export async function runPlan(
  plan: Plan,
  opts: DispatchOptions & { concurrency?: number },
): Promise<DispatchResult[]> {
  const conc = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
  const queue = [...plan.subtasks];
  const done: DispatchResult[] = [];
  let active = 0;

  return new Promise<DispatchResult[]>((resolve) => {
    const pump = () => {
      if (queue.length === 0 && active === 0) {
        resolve(done.sort((a, b) => a.id.localeCompare(b.id)));
        return;
      }
      while (active < conc && queue.length > 0) {
        const sub = queue.shift()!;
        active++;
        opts.onUpdate?.(`${sub.id} (${sub.model.id}) trabalhando...`);
        void dispatchSubtask(sub, opts)
          .catch((e): DispatchResult => ({
            id: sub.id, role: sub.role, model: sub.model.id, ok: false, output: "",
            via: "none", error: String(e), durationMs: 0,
          }))
          .then((r) => {
            done.push(r);
            active--;
            opts.onUpdate?.(`${sub.id} ${r.ok ? "concluido" : "falhou"} em ${Math.round(r.durationMs / 1000)}s`);
            pump();
          });
      }
    };
    pump();
  });
}

/** sintese final: um modelo gratuito forte junta tudo; se falhar, concatena. */
export async function synthesize(
  plan: Plan,
  results: readonly DispatchResult[],
  opts: DispatchOptions,
): Promise<{ text: string; via: string }> {
  const ok = results.filter((r) => r.ok && r.output.trim());
  if (!ok.length) {
    return {
      text: results.map((r) => `## ${r.id} / ${r.role} (${r.model}) — FALHOU\n${r.error ?? "sem detalhe"}`).join("\n\n"),
      via: "nenhuma",
    };
  }
  if (ok.length === 1) return { text: ok[0].output, via: "unico-agente" };
  const blocos = ok
    .map((r) => `### ${r.role.toUpperCase()} — ${r.model}\n${r.output}`)
    .join("\n\n");

  const synthSub: SubTask = {
    id: "synth",
    role: "docs",
    kind: "review",
    model: plan.synthesizer,
    title: `sintese: ${plan.task.slice(0, 60)}`,
    prompt: [
      "Voce recebeu o resultado de varios agentes que trabalharam em paralelo na mesma tarefa.",
      "Consolide em UMA resposta final para o usuario, em portugues do Brasil:",
      "- resolva divergencias dizendo qual versao vale e por que;",
      "- mantenha todo detalhe acionavel (comandos, arquivos, trechos de codigo);",
      "- descarte repeticao e auto-elogio;",
      "- se algum agente falhou, diga o que ficou sem cobertura.",
      "",
      `TAREFA ORIGINAL:\n${plan.task}`,
      "",
      `RESULTADOS DOS AGENTES:\n${blocos}`,
    ].join("\n"),
    rationale: "sintese",
    dependsOn: [],
  };
  try {
    const r = await dispatchSubtask(synthSub, opts);
    if (r.ok && r.output.trim()) return { text: r.output, via: `sintese:${r.model} (${r.via})` };
  } catch { /* cai no deterministico */ }
  return { text: blocos, via: "concatenacao (sintese indisponivel)" };
}

/** resumo textual do plano para o usuario/modelo */
export function describePlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Tarefa: ${plan.task}`);
  lines.push(`Tipos detectados: ${plan.kinds.join(", ")}`);
  if (plan.reason.length) lines.push(`Por que: ${plan.reason.join("; ")}`);
  lines.push("");
  lines.push("Divisao entre os gratuitos:");
  for (const s of plan.subtasks) {
    lines.push(`- ${s.id} [${s.role}] -> ${s.model.name} (${s.model.id}, 0 theos) — ${s.rationale}`);
  }
  lines.push("");
  lines.push(`Sintese final: ${plan.synthesizer.name} (${plan.synthesizer.id})`);
  for (const n of plan.notes) lines.push(`obs: ${n}`);
  return lines.join("\n");
}

export { PREFERENCE };
