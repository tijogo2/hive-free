/**
 * free-hive / catalog.ts
 *
 * Catalogo dos modelos GRATUITOS (0 theos/per-request) do DeepAI Code, com o perfil
 * de forca de cada um levantado a partir de benchmarks publicos (set/2026):
 *
 *  - Artificial Analysis Intelligence Index (AA) e sub-scores
 *  - DeepSWE v1.1 (engenharia de software agentica / patch real em repo)
 *  - Terminal-Bench (trabalho de CLI/terminal)
 *  - AutomationBench (automacao multi-step / tool calling)
 *  - AA-LCR (long context reasoning)
 *  - relatorios de vendor (OpenAI, Xiaomi MiMo, Upstage, Z.ai) + Malcat RE benchmark
 *
 * Nada aqui custa theos. Modelos pagos existem no catalogo apenas para documentar
 * o porque de nao serem usados por padrao (o router recusa pago sem allowPaid).
 */

export const HIVE_VERSION = "0.1.0";

export type TaskKind =
  | "plan"        // decompor tarefa, arquitetura, estrategia
  | "implement"   // escrever/alterar codigo
  | "terminal"    // CLI, build, scripts de shell, ambiente
  | "debug"       // caca a bug, leitura de stack trace
  | "review"      // revisao critica, segunda opiniao
  | "long-context"// varrer repo/logs/documentos enormes
  | "bulk"        // volume alto, tarefas repetitivas em paralelo
  | "ui"          // computer use / GUI / multimodal
  | "security"    // seguranca, analise de binario, engenharia reversa
  | "docs"        // escrita longa, documentacao, traducao
  | "triage"      // classificacao rapida e barata
  | "math";       // raciocinio formal, numeros

export interface FreeModel {
  /** id do modelo no catalogo do app (provider deepai) */
  id: string;
  /** slug completo usado em target.model do delegate_task */
  slug: string;
  name: string;
  vendor: string;
  /** janela de contexto em tokens */
  ctx: number;
  /** saida maxima em tokens */
  maxOut: number;
  /** so texto (sem visao) */
  textOnly: boolean;
  /** Artificial Analysis Intelligence Index quando publicado */
  aa?: number;
  /** DeepSWE v1.1 quando publicado (quanto maior melhor) */
  deepswe?: number;
  /** velocidade de saida aproximada, tokens/s */
  tps?: number;
  strengths: string[];
  cautions: string[];
  /** tipos de tarefa onde este modelo e a melhor escolha */
  bestFor: TaskKind[];
  /** fontes usadas para o perfil */
  sources: string[];
}

const S = {
  yotta: "yottalabs.ai/post/deepseek-v4-1-flash-vs-glm-5-3-flash-2026",
  aa: "artificialanalysis.ai",
  flow: "flowtivity.ai/blog/glm-5-3-flash-vs-deepseek-v4-flash-dgx-spark-benchmark",
  mimoNews: "mimo.mi.com/docs/news/latest/v2-6",
  mimoRl: "redreamality.com/blog/mimo-v2-6-rl-metrics-and-incident-analysis",
  lmrank: "lmrank.com/model/upstage-solar-mini-4",
  luna: "emergent.sh/learn/gpt-6-luna-benchmarks",
  tokenapp: "token.app/compare/gpt-6-luna-vs-crouton-alpha",
  glyph: "aclanthology.org/2026.acl-long.1722",
  malcat: "malcat.fr/category/malcat.html",
  deepai: "deepai.org/chat/ai-code",
};

export const FREE_MODELS: readonly FreeModel[] = [
  {
    id: "mimo-2.6-pro",
    slug: "deepai/mimo-2.6-pro",
    name: "MiMo 2.6 Pro",
    vendor: "Xiaomi",
    ctx: 1_048_576,
    maxOut: 131_072,
    textOnly: false,
    aa: 46,
    deepswe: 72.57,
    strengths: [
      "maior AA Intelligence Index de todo o conjunto gratuito (46), acima de Kimi K3",
      "RL massivo em tarefas agenticas: em benchmarks de agent fica no nivel de Opus 5 / GPT-5.6 Sol",
      "multimodal nativo + computer use (entende GUI, opera apps de escritorio)",
      "DeepSWE 72.6: resolucao de issue real em repo multi-arquivo",
    ],
    cautions: [
      "AutomationBench (~51%) fica abaixo do DeepSeek V4.1 Flash (69%)",
      "mais lento que os Flash: use para o passo dificil, nao para volume",
    ],
    bestFor: ["plan", "implement", "debug", "review", "ui"],
    sources: [S.mimoNews, S.mimoRl, S.aa],
  },
  {
    id: "deepseek-v4.1-flash",
    slug: "deepai/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    vendor: "DeepSeek",
    ctx: 1_048_576,
    maxOut: 131_072,
    textOnly: false,
    aa: 40,
    deepswe: 74.2,
    strengths: [
      "melhor AutomationBench do conjunto gratuito (69% vs 60% do GLM 5.3 Flash): automacao multi-step e tool calling confiavel",
      "melhor AA-LCR (84%): raciocinio sobre contexto longo",
      "DeepSWE 74.2 (vendor) / foco declarado em coding agentico e trabalho de terminal",
      "no teste independente DeepSWE (5 tarefas, Go+Python) entregou patch em 4 de 5; o GLM zerou",
    ],
    cautions: [
      "AA composite (40) 2 pontos abaixo do GLM 5.3 Flash — dentro do ruido",
      "menos forte que GLM em Terminal-Bench 4.0 (27% vs 33%)",
    ],
    bestFor: ["implement", "long-context", "debug", "triage"],
    sources: [S.yotta, S.flow, S.aa],
  },
  {
    id: "glm-5.3-flash",
    slug: "deepai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    vendor: "Z.ai",
    ctx: 1_048_576,
    maxOut: 131_072,
    textOnly: false,
    aa: 42,
    deepswe: 63.4,
    strengths: [
      "melhor Terminal-Bench 4.0 do conjunto gratuito (33% vs 27%): trabalho de CLI, build, ambiente",
      "AA 42: o mais alto dos Flash de texto, empata com DeepSeek em HLE (40) e SciCode (52)",
      "modelo default do app, 320B total / 18B ativos (rapido o bastante para loop de ferramenta)",
    ],
    cautions: [
      "no teste independente de DeepSWE entrou em loop de tool-call em 2 de 5 tarefas e morreu por context overflow em outras 2",
      "DeepSWE 63.4: fica atras de DeepSeek/MiMo em patch multi-arquivo — nao e o braco de implementacao",
    ],
    bestFor: ["terminal", "triage", "bulk"],
    sources: [S.yotta, S.flow, S.aa],
  },
  {
    id: "mimo-2.6-flash",
    slug: "deepai/mimo-2.6-flash",
    name: "MiMo 2.6 Flash",
    vendor: "Xiaomi",
    ctx: 1_048_576,
    maxOut: 131_072,
    textOnly: false,
    deepswe: 65.68,
    strengths: [
      "DeepSWE 65.7: coding agentico solido por uma fracao do custo do Pro",
      "herda computer use / multimodal da familia 2.6",
      "tool calling da familia MiMo e estavel (a 2.x subiu de 64% para 97% de acuracia)",
      "bom braco executor em paralelo: varios workers baratos ao mesmo tempo",
    ],
    cautions: [
      "patamar abaixo do Pro em tarefa dificil de arquitetura",
      "AutomationBench ~52.7: nao e o melhor para orquestracao multi-step",
    ],
    bestFor: ["implement", "bulk", "ui"],
    sources: [S.mimoRl, S.mimoNews],
  },
  {
    id: "gpt-6-luna",
    slug: "deepai/gpt-6-luna",
    name: "GPT-6 Luna",
    vendor: "OpenAI",
    ctx: 1_048_576,
    maxOut: 128_000,
    textOnly: false,
    aa: 37,
    deepswe: 66.6,
    tps: 157,
    strengths: [
      "o mais rapido do conjunto: ~157 tok/s no esforco maximo — bom para rascunho e segunda opiniao",
      "DeepSWE 66.6 e Coding Agent Index 41: coding equilibrado",
      "linhagem OpenAI: instrucao seguida e factuality consistentes",
    ],
    cautions: [
      "AA 37: abaixo de MiMo Pro (46), GLM Flash (42) e DeepSeek (40)",
      "Coding Agent Index caiu 2 pontos vs GPT-5.6 Luna",
    ],
    bestFor: ["review", "triage", "docs"],
    sources: [S.luna, S.aa, S.tokenapp],
  },
  {
    id: "crouton-alpha",
    slug: "deepai/crouton-alpha",
    name: "Crouton Alpha",
    vendor: "Stealth",
    ctx: 1_048_576,
    maxOut: 131_072,
    textOnly: false,
    strengths: [
      "modelo stealth: sem benchmarks publicos, comportamento desconhecido",
      "janela de 1M tokens e saida muito longa — serve como 'gerador de volume' e diversidade de opiniao",
    ],
    cautions: [
      "sem benchmark independente publicado: nunca use como unica voz em decisao critica",
      "trate a saida como rascunho a ser validado por MiMo Pro / DeepSeek",
    ],
    bestFor: ["docs", "bulk"],
    sources: [S.tokenapp, S.deepai],
  },
  {
    id: "glyph-cluster",
    slug: "deepai/glyph-cluster",
    name: "Glyph Cluster",
    vendor: "Stealth",
    ctx: 256_000,
    maxOut: 131_072,
    textOnly: true,
    strengths: [
      "familia Glyph: compressao texto->visual, feita para cobrir muito mais texto por token",
      "melhor opcao para triagem de entrada gigante (logs, dumps, arvore de repo) quando a janela dobra de valor",
    ],
    cautions: [
      "contexto de 256k (metade dos Flash)",
      "so texto e fraco em strings raras/alfanumericas (UUIDs, hashes, IDs): nao use para copiar identificador exato",
    ],
    bestFor: ["long-context", "triage"],
    sources: [S.glyph, S.deepai],
  },
  {
    id: "solar-mini-4",
    slug: "deepai/solar-mini-4",
    name: "Solar Mini 4",
    vendor: "Upstage",
    ctx: 524_288,
    maxOut: 131_072,
    textOnly: true,
    strengths: [
      "35B MoE com 3B ativos: barato e rapido para volume alto",
      "contexto de 524k para leitura de documento longo e coding long-context",
    ],
    cautions: [
      "capacidade ativa pequena perto dos frontier: nao peca arquitetura complexa",
      "cobertura independente de benchmark limitada no lancamento",
    ],
    bestFor: ["bulk", "docs", "triage"],
    sources: [S.lmrank],
  },
  {
    id: "deepai-cyber",
    slug: "deepai/deepai-cyber",
    name: "DeepAI Cyber",
    vendor: "DeepAI",
    ctx: 65_536,
    maxOut: 8_192,
    textOnly: true,
    strengths: [
      "especializado em seguranca/ciberseguranca pela propria DeepAI",
      "bom para leitura de achado, CVE, threat model e revisao de seguranca de patch pequeno",
    ],
    cautions: [
      "contexto de 64k e saida de 8k: so cabe tarefa pequena — nunca mande repo inteiro",
      "text-only",
    ],
    bestFor: ["security"],
    sources: [S.deepai, S.malcat],
  },
] as unknown as readonly FreeModel[];

/** Modelos que aparecem no catalogo do app mas custam theos. Nunca usados por padrao. */
export const PAID_MODELS: Readonly<Record<string, number>> = {
  "deepai/glm-5.3": 3,
  "deepai/kimi-k3": 3,
  "deepai/muse-spark-1.3": 6,
  "deepai/gpt-6.1-sol": 10,
  "deepai/gemini-4-argon": 10,
  "deepai/claude-opus-5-5": 15,
  "deepai/muse-wonder": 15,
  "deepai/claude-fable-5-1": 25,
  "deepai/gpt-6-astra": 50,
};

/**
 * Preferencia por tipo de tarefa, derivada dos benchmarks acima.
 * A ordem e a prioridade: o primeiro disponivel vence.
 */
export const PREFERENCE: Readonly<Record<TaskKind, readonly string[]>> = {
  plan: ["mimo-2.6-pro", "deepseek-v4.1-flash", "gpt-6-luna"],
  implement: ["mimo-2.6-pro", "deepseek-v4.1-flash", "mimo-2.6-flash", "gpt-6-luna"],
  terminal: ["glm-5.3-flash", "deepseek-v4.1-flash", "mimo-2.6-flash"],
  debug: ["deepseek-v4.1-flash", "mimo-2.6-pro", "gpt-6-luna"],
  review: ["mimo-2.6-pro", "gpt-6-luna", "deepseek-v4.1-flash"],
  "long-context": ["deepseek-v4.1-flash", "glyph-cluster", "mimo-2.6-pro"],
  bulk: ["mimo-2.6-flash", "solar-mini-4", "glm-5.3-flash", "crouton-alpha"],
  ui: ["mimo-2.6-pro", "mimo-2.6-flash"],
  security: ["deepai-cyber", "mimo-2.6-pro", "deepseek-v4.1-flash"],
  docs: ["gpt-6-luna", "solar-mini-4", "crouton-alpha", "mimo-2.6-pro"],
  triage: ["glm-5.3-flash", "gpt-6-luna", "solar-mini-4"],
  math: ["deepseek-v4.1-flash", "mimo-2.6-pro", "glm-5.3-flash"],
};

export const TASK_KINDS = Object.keys(PREFERENCE) as TaskKind[];

export function byId(id: string): FreeModel | undefined {
  const clean = id.replace(/^deepai\//, "");
  return FREE_MODELS.find((m) => m.id === clean);
}

export function isFreeModel(modelId: string): boolean {
  const clean = modelId.replace(/^deepai\//, "");
  return FREE_MODELS.some((m) => m.id === clean);
}

export interface PickOptions {
  /** exclui modelos marcados como textOnly */
  needsVision?: boolean;
  /** contexto minimo necessario em tokens */
  minCtx?: number;
  /** ids que nao podem ser escolhidos */
  exclude?: readonly string[];
}

/** Escolhe o melhor modelo gratuito para um tipo de tarefa. */
export function pickModel(kind: TaskKind, opts: PickOptions = {}): FreeModel | undefined {
  const exclude = new Set((opts.exclude ?? []).map((e) => e.replace(/^deepai\//, "")));
  const order = PREFERENCE[kind] ?? [];
  for (const id of order) {
    if (exclude.has(id)) continue;
    const m = byId(id);
    if (!m) continue;
    if (opts.needsVision && m.textOnly) continue;
    if (opts.minCtx && m.ctx < opts.minCtx) continue;
    return m;
  }
  // volta ao conjunto completo, do mais forte para o mais fraco
  return FREE_MODELS.filter((m) => !exclude.has(m.id))
    .filter((m) => (opts.needsVision ? !m.textOnly : true))
    .filter((m) => (opts.minCtx ? m.ctx >= opts.minCtx : true))
    .sort((a, b) => (b.aa ?? 0) - (a.aa ?? 0))[0];
}

/** Classificacao deterministica (custo zero) da tarefa em tipos. */
export interface Classification {
  kinds: TaskKind[];
  reason: string[];
  needsVision: boolean;
  estimatedInput: number;
  /** true quando algum sinal real casou (nao e o palpite padrao) */
  explicit: boolean;
}

// Sem \b no fim: portugues flexiona (implementar, revisar, vulnerabilidade). O \b inicial
// garante que casamos o comeco de palavra, nao o meio.
const SIGNALS: ReadonlyArray<{ kind: TaskKind; re: RegExp; why: string }> = [
  { kind: "security", re: /\b(vulnerab|exploit|cve-\d|malware|payload|pentest|engenharia reversa|reverse eng|descompil|ghidra|radare|\bida\b|analise este \.?(exe|dll|bin)|seguranc)/i, why: "pede analise de seguranca/RE" },
  { kind: "ui", re: /\b(screenshot|captura de tela|clicar|computer use|interface grafica|arrastar|tela do app)/i, why: "envolve percepcao/acao de interface" },
  { kind: "long-context", re: /\b(logs? (gigantes|completos)|todo o repo|todo o codigo|milhares de linha|\bdump\b|varre(dur|r) (tudo|o repo)|contexto (longo|enorme)|projeto (inteiro|todo))/i, why: "entrada muito grande" },
  { kind: "terminal", re: /\b(build|compil|instalar|\bsetup\b|ambiente|terminal|\bcli\b|bash|powershell|script de shell|deploy|docker|makefile|npm install)/i, why: "trabalho de CLI/build" },
  { kind: "debug", re: /\b(bug|erro|stack ?trace|exception|falhando|quebrad|nao funciona|investig|regressao|corrig)/i, why: "investigacao de defeito" },
  { kind: "implement", re: /\b(implement|refator|escrev\w* (o )?codigo|cri[ae]r? (uma? )?(funcao|classe|componente|api|endpoint|teste)|adicion\w+|novo modulo|desenvolv\w+)/i, why: "escrita de codigo" },
  { kind: "review", re: /\b(revis|code review|segunda opiniao|critique|\baudit|avalie|confira o (codigo|patch))/i, why: "revisao critica" },
  { kind: "docs", re: /\b(document|readme|escrev\w* (um )?(texto|artigo|post)|traduz|resum\w+|manual|guia)/i, why: "escrita/documentacao" },
  { kind: "plan", re: /\b(planej|arquitetur|decomponh|estrateg|desenhe a solucao|roadmap|divida em etapas|orquestr)/i, why: "planejamento/decomposicao" },
  { kind: "math", re: /\b(calcul|matematic|\bprove\b|derivad|estatistic|probabilidade)/i, why: "raciocinio formal" },
  { kind: "triage", re: /\b(classifiq|triagem|etiquet|categoriz|organiz\w* em (lista|tabela))/i, why: "classificacao em volume" },
  { kind: "bulk", re: /\b(em lote|todas as ocorrencias|para cada arquivo|em massa|mil (arquivos|itens)|repetitiv)/i, why: "volume/repeticao" },
];

export function classify(task: string, inputTokens = 0): Classification {
  const texto = task.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hits: TaskKind[] = [];
  const reason: string[] = [];
  for (const s of SIGNALS) {
    if (s.re.test(texto)) {
      hits.push(s.kind);
      reason.push(`${s.kind}: ${s.why}`);
    }
  }
  const needsVision = /\b(screenshot|imagem|figura|captura de tela|png|jpe?g)\b/.test(texto);
  const explicit = hits.length > 0;
  if (inputTokens > 200_000 && !hits.includes("long-context")) {
    hits.push("long-context");
    reason.push("long-context: entrada estimada acima de 200k tokens");
  }
  if (hits.length === 0) {
    hits.push("implement", "plan");
    reason.push("sem sinal explicito: assume implementacao + planejamento");
  }
  // sempre inclui review quando ha codigo sendo escrito (paranoia barata e gratuita)
  if (hits.includes("implement") && !hits.includes("review")) hits.push("review");
  return { kinds: [...new Set(hits)], reason, needsVision, estimatedInput: inputTokens, explicit };
}

/** Conversa social/ack: nao merece enxame nem bloqueio. */
const SOCIAL = /^(oi|ola|opa|bom dia|boa tarde|boa noite|obrigad[a-z]*|valeu|vlw|ok|okay|beleza|tudo bem|testando|teste|ping|sim|pode|isso|show|perfeito|entendi|entendido|certo|quem (e|é) voce|o que voce (faz|pode fazer)|como funciona)\b/i;

/** O usuario pediu explicitamente para nao usar o enxame neste pedido. */
const SEM_ENXAME = /\b(sem|nao|não)\s+(usar|use|chame|chamar|ligue|ligar)\b[^.]{0,20}\b(hive|enxame)\b|\b(hive|enxame)\s*(off|nunca)\b/i;

/**
 * Decide se o turno passa pelo enxame. Politica SEMPRE ATIVA: o padrao e entrar,
 * e as unicas saidas sao conversa social curta, pedido explicito de nao usar, e
 * os proprios comandos (/hive) — que o hook nem considera.
 */
export function shouldOrchestrate(prompt: string): { yes: boolean; why: string } {
  const t = (prompt ?? "").trim();
  if (!t) return { yes: false, why: "prompt vazio" };
  if (SEM_ENXAME.test(t)) return { yes: false, why: "o pedido dispensa o enxame" };
  if (t.length <= 60 && SOCIAL.test(t)) return { yes: false, why: "conversa social" };
  const cls = classify(t);
  return {
    yes: true,
    why: cls.explicit ? cls.reason.join("; ") : "politica sempre ativa (sem sinal explicito, mas e trabalho)",
  };
}

/** Tabela compacta para injetar no prompt do sistema. */
export function catalogTable(): string {
  return FREE_MODELS.map((m) => {
    const tags = [
      m.aa ? `AA ${m.aa}` : undefined,
      m.deepswe ? `DeepSWE ${m.deepswe}` : undefined,
      `${Math.round(m.ctx / 1024)}k ctx`,
      m.textOnly ? "text-only" : "multimodal",
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${m.id} (${m.name}, ${m.vendor}) — ${tags} — melhor em: ${m.bestFor.join("/")}`;
  }).join("\n");
}
