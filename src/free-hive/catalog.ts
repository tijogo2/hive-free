/**
 * free-hive / catalog.ts
 *
 * Catalogo de TODOS os modelos do enxame (deepai free, deepai THEO e opencode), com o perfil
 * de forca de cada um levantado a partir de benchmarks publicos (set/2026):
 *
 *  - Artificial Analysis Intelligence Index (AA) e sub-scores
 *  - DeepSWE v1.1 (engenharia de software agentica / patch real em repo)
 *  - Terminal-Bench (trabalho de CLI/terminal)
 *  - AutomationBench (automacao multi-step / tool calling)
 *  - AA-LCR (long context reasoning)
 *  - relatorios de vendor (OpenAI, Xiaomi MiMo, Upstage, Z.ai) + Malcat RE benchmark
 *
 * Modelos em THEO entram com orcamento (budget.ts): teto por request, margem de
 * seguranca diaria e fallback para gratuito. O enxame nunca gasta a ultima fatia.
 */

export const HIVE_VERSION = "0.2.0";

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
  /** providerInstanceId do app (deepai ou opencode) */
  provider?: "deepai" | "opencode";
  /** lane de cota: rate limit + theos */
  lane?: "deepai-free" | "deepai-theo" | "nvidia" | "zen";
  /** theos cobrados por request (0/ausente = gratuito) */
  theos?: number;
  tier?: "free" | "paid";
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
  /** velocidade de saida aproximada, tokens/s (Luna 157 e medida; demais estimadas) — usada no roteamento por velocidade */
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
    tps: 55,
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
    tps: 95,
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
    tps: 120,
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
    tps: 110,
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
    id: "qwen-3.8-flash",
    slug: "deepai/qwen-3.8-flash",
    name: "Qwen 3.8 Flash",
    vendor: "Alibaba",
    ctx: 991_000,
    maxOut: 128_000,
    textOnly: false,
    tps: 105,
    strengths: [
      "gratuito (0 theos) e multimodal, com 991k de contexto",
      "familia Qwen: tool calling estavel e bom em codigo",
    ],
    cautions: ["benchmarks independentes ainda escassos nesta versao"],
    bestFor: ["implement", "debug", "math", "bulk"],
    sources: [S.deepai],
  },
  {
    id: "minimax-m3.1-flash",
    slug: "deepai/minimax-m3.1-flash",
    name: "MiniMax M3.1 Flash",
    vendor: "MiniMax",
    ctx: 1_048_576,
    maxOut: 131_072,
    textOnly: false,
    tps: 100,
    strengths: [
      "gratuito (0 theos), 1M de contexto e multimodal",
      "bom executor em paralelo: familia MiniMax com tool calling consistente",
    ],
    cautions: ["o irmao pagos (M3) existe; este e o Flash gratuito, capacidade menor"],
    bestFor: ["implement", "bulk", "debug"],
    sources: [S.deepai],
  },
  {
    id: "glyph-cluster",
    slug: "deepai/glyph-cluster",
    name: "Glyph Cluster",
    vendor: "Stealth",
    ctx: 256_000,
    maxOut: 131_072,
    textOnly: true,
    tps: 140,
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
    tps: 160,
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
    tps: 70,
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

/**
 * Modelos pagos em THEO (premier=true no catalogo do app). O custo e POR REQUEST,
 * nao por token, e desconta da cota diaria da lane deepai-theo.
 */
interface PaidSpec {
  id: string;
  name: string;
  vendor: string;
  theos: number;
  ctx: number;
  maxOut: number;
  textOnly?: boolean;
  bestFor: TaskKind[];
  note: string;
}

const PAID_SPEC: readonly PaidSpec[] = [
  { id: "minimax-m3", name: "MiniMax M3", vendor: "MiniMax", theos: 2, ctx: 512_000, maxOut: 131_000, textOnly: true, bestFor: ["bulk", "triage", "docs"], note: "mais barato dos pagos" },
  { id: "glm-5.3", name: "GLM 5.3", vendor: "Z.ai", theos: 3, ctx: 1_048_576, maxOut: 131_072, textOnly: true, bestFor: ["terminal", "triage", "bulk"], note: "familia do Flash com mais capacidade" },
  { id: "kimi-k3", name: "Kimi K3", vendor: "Moonshot", theos: 3, ctx: 1_048_576, maxOut: 131_072, bestFor: ["plan", "long-context", "docs"], note: "contexto longo por 3 theos" },
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", vendor: "Muse", theos: 6, ctx: 1_048_576, maxOut: 131_072, bestFor: ["implement", "ui", "debug"], note: "meio de escada em coding" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", vendor: "OpenAI", theos: 10, ctx: 1_048_576, maxOut: 128_000, bestFor: ["plan", "review", "math", "debug"], note: "mais forte de proposito geral abaixo de 15" },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", vendor: "Google", theos: 10, ctx: 1_048_576, maxOut: 131_072, bestFor: ["long-context", "docs", "ui"], note: "contexto longo multimodal" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", vendor: "Anthropic", theos: 15, ctx: 1_000_000, maxOut: 64_000, bestFor: ["review", "security", "plan"], note: "revisao critica; saida de 64k" },
  { id: "muse-wonder", name: "Muse Wonder", vendor: "Muse", theos: 15, ctx: 1_048_576, maxOut: 131_072, bestFor: ["plan", "implement", "long-context"], note: "frontier multimodal" },
  { id: "qwen-3.8-max-prime", name: "Qwen 3.8 Max Prime", vendor: "Alibaba", theos: 15, ctx: 1_000_000, maxOut: 131_072, bestFor: ["implement", "math", "debug"], note: "coding forte" },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", vendor: "Anthropic", theos: 20, ctx: 1_000_000, maxOut: 64_000, bestFor: ["docs", "review", "plan"], note: "escrita longa e revisao" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", vendor: "OpenAI", theos: 50, ctx: 1_048_576, maxOut: 128_000, bestFor: ["plan", "review"], note: "o mais caro: 50 theos por request" },
];

export const PAID_MODELS: Readonly<Record<string, number>> = Object.fromEntries(
  PAID_SPEC.map((m) => [`deepai/${m.id}`, m.theos]),
);

const PAID: readonly FreeModel[] = PAID_SPEC.map((m) => ({
  id: m.id,
  slug: `deepai/${m.id}`,
  name: m.name,
  vendor: m.vendor,
  provider: "deepai" as const,
  lane: "deepai-theo" as const,
  theos: m.theos,
  tier: "paid" as const,
  ctx: m.ctx,
  maxOut: m.maxOut,
  textOnly: m.textOnly ?? false,
  strengths: [`${m.theos} theos por request (custo por chamada, nao por token)`, ...m.bestFor.map((k) => `bom em ${k}`)],
  cautions: [m.note, "divide a mesma cota diaria de theos com os outros pagos"],
  bestFor: m.bestFor,
  sources: ["deepai.org/pricing", "models.json do app"],
}));

/**
 * OpenCode: gratuitos verificados nesta sessao. Duas lanes: `nvidia` (NIM, 40 rpm e
 * 10.000/dia) e `zen` (OpenCode Zen, sem numero publicado exceto LongCat 100/dia).
 */
interface OcSpec {
  id: string;
  name: string;
  vendor: string;
  lane: "nvidia" | "zen";
  ctx: number;
  maxOut: number;
  tps: number;
  textOnly?: boolean;
  bestFor: TaskKind[];
  note: string;
}

const OC_SPEC: readonly OcSpec[] = [
  { id: "nvidia/nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B", vendor: "NVIDIA", lane: "nvidia", ctx: 1_048_576, maxOut: 131_072, tps: 35, bestFor: ["plan", "review", "long-context", "security"], note: "o mais forte do NIM" },
  { id: "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", name: "Nemotron 3.5 Super VL 120B", vendor: "NVIDIA", lane: "nvidia", ctx: 262_144, maxOut: 131_072, tps: 45, bestFor: ["ui", "docs", "review", "long-context"], note: "multimodal grande" },
  { id: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning 30B", vendor: "NVIDIA", lane: "nvidia", ctx: 262_144, maxOut: 131_072, tps: 120, bestFor: ["terminal", "triage", "bulk"], note: "rapido e barato em volume" },
  { id: "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", name: "Nemotron 3 Nano Omni", vendor: "NVIDIA", lane: "nvidia", ctx: 262_144, maxOut: 131_072, tps: 130, bestFor: ["triage", "bulk"], note: "o mais rapido do NIM para classificacao" },
  { id: "nvidia/minimaxai/minimax-m3.1-flash", name: "MiniMax M3.1 Flash (NIM)", vendor: "NVIDIA", lane: "nvidia", ctx: 1_048_576, maxOut: 131_072, tps: 90, bestFor: ["implement", "debug", "bulk"], note: "mesmo modelo do deepai, servido pelo NIM" },
  { id: "nvidia/meta/muse-glimmer-30b", name: "Muse Glimmer 30B", vendor: "NVIDIA", lane: "nvidia", ctx: 262_144, maxOut: 131_072, tps: 70, bestFor: ["docs", "ui", "review"], note: "escrita e interface" },
  { id: "nvidia/poolside/laguna-xs-2.1", name: "Laguna XS 2.1", vendor: "NVIDIA", lane: "nvidia", ctx: 262_144, maxOut: 131_072, tps: 110, bestFor: ["bulk", "triage", "terminal"], note: "executor pequeno e rapido" },
  { id: "nvidia/openai/gpt-oss-20b", name: "GPT OSS 20B", vendor: "NVIDIA", lane: "nvidia", ctx: 131_072, maxOut: 131_072, tps: 90, bestFor: ["implement", "debug", "math"], note: "aberto da OpenAI, bom em codigo curto" },
  { id: "nvidia/google/gemma-4-31b-it", name: "Gemma 4 31B IT", vendor: "NVIDIA", lane: "nvidia", ctx: 131_072, maxOut: 131_072, tps: 75, bestFor: ["docs", "bulk", "triage"], note: "texto e resumo" },
  { id: "nvidia/meta/llama-3.2-90b-vision-instruct", name: "Llama 3.2 90B Vision", vendor: "NVIDIA", lane: "nvidia", ctx: 131_072, maxOut: 131_072, tps: 50, bestFor: ["ui", "docs"], note: "visao" },
  { id: "nvidia/stepfun-ai/step-5-preview", name: "Step 5 Preview", vendor: "NVIDIA", lane: "nvidia", ctx: 262_144, maxOut: 131_072, tps: 55, bestFor: ["plan", "implement", "long-context"], note: "preview: bom em raciocinio, sem garantia de estabilidade" },
  { id: "nvidia/deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (NIM)", vendor: "NVIDIA", lane: "nvidia", ctx: 1_048_576, maxOut: 131_072, tps: 3, bestFor: ["long-context"], note: "LENTO: ~15 min para uma resposta curta no teste desta sessao" },
  { id: "opencode/beam-free", name: "Beam Free", vendor: "OpenCode", lane: "zen", ctx: 262_144, maxOut: 131_072, tps: 60, bestFor: ["implement", "bulk"], note: "free por tempo limitado" },
  { id: "opencode/big-pickle", name: "Big Pickle", vendor: "OpenCode", lane: "zen", ctx: 262_144, maxOut: 131_072, tps: 55, bestFor: ["implement", "review"], note: "modelo stealth, sem benchmark" },
  { id: "opencode/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", vendor: "OpenCode", lane: "zen", ctx: 1_048_576, maxOut: 131_072, tps: 90, bestFor: ["implement", "debug", "long-context"], note: "mesmo perfil do DeepSeek gratuito" },
  { id: "opencode/flint-40b-free", name: "Flint 40B Free", vendor: "OpenCode", lane: "zen", ctx: 262_144, maxOut: 131_072, tps: 80, bestFor: ["implement", "bulk", "terminal"], note: "free por tempo limitado" },
  { id: "opencode/glm-5.3-flash-free", name: "GLM 5.3 Flash Free", vendor: "OpenCode", lane: "zen", ctx: 1_048_576, maxOut: 131_072, tps: 110, bestFor: ["terminal", "triage", "bulk"], note: "mesmo perfil do GLM Flash gratuito" },
  { id: "opencode/iceman-free", name: "Iceman Free", vendor: "OpenCode", lane: "zen", ctx: 262_144, maxOut: 131_072, tps: 60, bestFor: ["implement", "review"], note: "modelo stealth" },
  { id: "opencode/inkling-2-small-free", name: "Inkling 2 Small Free", vendor: "OpenCode", lane: "zen", ctx: 262_144, maxOut: 131_072, tps: 100, bestFor: ["triage", "bulk", "docs"], note: "pequeno e rapido; provedor retem dados" },
  { id: "opencode/longcat-2.5-free", name: "LongCat 2.5 Free", vendor: "OpenCode", lane: "zen", ctx: 1_048_576, maxOut: 131_072, tps: 70, bestFor: ["long-context", "docs"], note: "unico com limite publicado: 100 req/dia" },
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", vendor: "OpenCode", lane: "zen", ctx: 1_048_576, maxOut: 131_072, tps: 105, bestFor: ["implement", "bulk", "ui"], note: "mesmo perfil do MiMo Flash gratuito" },
  { id: "opencode/minimax-m3.1-flash-free", name: "MiniMax M3.1 Flash Free", vendor: "OpenCode", lane: "zen", ctx: 1_048_576, maxOut: 131_072, tps: 95, bestFor: ["implement", "debug", "bulk"], note: "free por tempo limitado" },
  { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", vendor: "OpenCode", lane: "zen", ctx: 262_144, maxOut: 131_072, tps: 120, bestFor: ["triage", "bulk", "terminal"], note: "rapido para volume" },
  { id: "opencode/nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", vendor: "OpenCode", lane: "zen", ctx: 262_144, maxOut: 131_072, tps: 45, bestFor: ["ui", "docs", "review"], note: "visao" },
];

const OPENCODE: readonly FreeModel[] = OC_SPEC.map((m) => ({
  id: m.id,
  slug: m.id,
  name: m.name,
  vendor: m.vendor,
  provider: "opencode" as const,
  lane: m.lane,
  theos: 0,
  tier: "free" as const,
  ctx: m.ctx,
  maxOut: m.maxOut,
  textOnly: m.textOnly ?? false,
  tps: m.tps,
  strengths: [`gratuito na lane ${m.lane}`, ...m.bestFor.map((k) => `bom em ${k}`)],
  cautions: [m.note],
  bestFor: m.bestFor,
  sources: ["verificado nesta sessao", m.lane === "nvidia" ? "build.nvidia.com/faq" : "opencode.ai/docs/console/models"],
}));

/** Todo o roster: gratuitos do deepai, opencode e pagos em THEO (nesta ordem). */
export const ALL_MODELS: readonly FreeModel[] = [...FREE_MODELS, ...OPENCODE, ...PAID];

/**
 * Preferencia por tipo de tarefa, derivada dos benchmarks acima.
 * A ordem e a prioridade: o primeiro disponivel vence.
 */
export const PREFERENCE: Readonly<Record<TaskKind, readonly string[]>> = {
  plan: ["mimo-2.6-pro", "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "nvidia/stepfun-ai/step-5-preview", "deepseek-v4.1-flash", "gpt-6.1-sol", "claude-opus-5-5", "muse-wonder"],
  implement: ["mimo-2.6-pro", "qwen-3.8-flash", "minimax-m3.1-flash", "deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash-free", "opencode/beam-free", "nvidia/minimaxai/minimax-m3.1-flash", "muse-spark-1.3", "gpt-6.1-sol"],
  terminal: ["glm-5.3-flash", "opencode/glm-5.3-flash-free", "opencode/flint-40b-free", "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", "opencode/nemotron-3.5-lightning-free", "glm-5.3"],
  debug: ["deepseek-v4.1-flash", "mimo-2.6-pro", "qwen-3.8-flash", "opencode/deepseek-v4.1-flash-free", "nvidia/openai/gpt-oss-20b", "minimax-m3.1-flash", "gpt-6-luna", "gpt-6.1-sol"],
  review: ["mimo-2.6-pro", "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "nvidia/meta/muse-glimmer-30b", "gpt-6-luna", "opencode/big-pickle", "claude-opus-5-5"],
  "long-context": ["deepseek-v4.1-flash", "glyph-cluster", "opencode/longcat-2.5-free", "nvidia/stepfun-ai/step-5-preview", "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "muse-wonder"],
  bulk: ["mimo-2.6-flash", "solar-mini-4", "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", "opencode/nemotron-3.5-lightning-free", "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "opencode/inkling-2-small-free", "nvidia/poolside/laguna-xs-2.1", "minimax-m3"],
  ui: ["mimo-2.6-pro", "mimo-2.6-flash", "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b", "opencode/nemotron-3.5-super-vl-free", "nvidia/meta/llama-3.2-90b-vision-instruct", "muse-spark-1.3"],
  security: ["deepai-cyber", "nvidia/nvidia/nemotron-3-ultra-550b-a55b", "mimo-2.6-pro", "claude-opus-5-5"],
  docs: ["gpt-6-luna", "solar-mini-4", "nvidia/meta/muse-glimmer-30b", "nvidia/google/gemma-4-31b-it", "opencode/inkling-2-small-free", "claude-fable-5-2"],
  triage: ["glm-5.3-flash", "gpt-6-luna", "solar-mini-4", "nvidia/poolside/laguna-xs-2.1", "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "opencode/inkling-2-small-free"],
  math: ["deepseek-v4.1-flash", "mimo-2.6-pro", "nvidia/openai/gpt-oss-20b", "qwen-3.8-flash", "gpt-6.1-sol"],
};

/* ---------------------------------------------------------------- helpers */

export function providerOf(m: FreeModel): "deepai" | "opencode" {
  return m.provider ?? "deepai";
}

export function theosOf(m: FreeModel): number {
  return m.theos ?? 0;
}

export function tierOf(m: FreeModel): "free" | "paid" {
  return m.tier ?? (theosOf(m) > 0 ? "paid" : "free");
}

export function laneOf(m: FreeModel): "deepai-free" | "deepai-theo" | "nvidia" | "zen" {
  return m.lane ?? (theosOf(m) > 0 ? "deepai-theo" : "deepai-free");
}

export const TASK_KINDS = Object.keys(PREFERENCE) as TaskKind[];

export function byId(id: string): FreeModel | undefined {
  const clean = id.replace(/^deepai\//, "");
  return ALL_MODELS.find((m) => m.id === clean || m.slug === id || m.slug === clean);
}

export function isFreeModel(modelId: string): boolean {
  const m = byId(modelId);
  return Boolean(m && tierOf(m) === "free");
}

export interface PickOptions {
  /** exclui modelos marcados como textOnly */
  needsVision?: boolean;
  /** contexto minimo necessario em tokens */
  minCtx?: number;
  /** ids que nao podem ser escolhidos */
  exclude?: readonly string[];
  /** ordem ja ajustada (ex.: aprendizado model-profile); senao usa PREFERENCE */
  order?: readonly string[];
  /** roteamento por velocidade: ordena por tps desc (bulk/triage/ask) */
  preferFast?: boolean;
}

/** Escolhe o melhor modelo gratuito para um tipo de tarefa. */
export function pickModel(kind: TaskKind, opts: PickOptions = {}): FreeModel | undefined {
  const exclude = new Set((opts.exclude ?? []).map((e) => e.replace(/^deepai\//, "")));
  const base = opts.order ?? PREFERENCE[kind] ?? [];
  // roteamento por tps: em volume/triagem o mais rapido entrega mais por minuto
  const order = opts.preferFast
    ? [...base].sort((a, b) => (byId(b)?.tps ?? 0) - (byId(a)?.tps ?? 0))
    : base;
  for (const id of order) {
    if (exclude.has(id)) continue;
    const m = byId(id);
    if (!m) continue;
    if (opts.needsVision && m.textOnly) continue;
    if (opts.minCtx && m.ctx < opts.minCtx) continue;
    return m;
  }
  // volta ao conjunto completo: gratuito antes de pago, e o mais forte primeiro
  return ALL_MODELS.filter((m) => !exclude.has(m.id) && !exclude.has(m.slug))
    .filter((m) => (opts.needsVision ? !m.textOnly : true))
    .filter((m) => (opts.minCtx ? m.ctx >= opts.minCtx : true))
    .sort((a, b) => {
      const tier = Number(tierOf(a) === "paid") - Number(tierOf(b) === "paid");
      if (tier !== 0) return tier;
      return (b.aa ?? 0) - (a.aa ?? 0);
    })[0];
}

/** veredito aprendido (pagina model-profile da memoria) que reordena o roteamento */
export interface ModelVerdict {
  model: string;
  kinds: TaskKind[];
  verdict: "bom" | "ruim" | "parcial";
}

/**
 * P1: aprendizado continuo — paginas model-profile do FreeHive ensinam o router.
 * "bom" sobe, "ruim" desce, o resto mantem a ordem dos benchmarks (sort estavel).
 */
export function applyVerdicts(
  kind: TaskKind,
  order: readonly string[],
  verdicts: readonly ModelVerdict[] = [],
): readonly string[] {
  const rank = (id: string): number => {
    const vs = verdicts.filter((v) => v.kinds.includes(kind) && (v.model === id || v.model === `deepai/${id}`));
    if (vs.some((v) => v.verdict === "ruim")) return -1;
    if (vs.some((v) => v.verdict === "bom")) return 1;
    return 0;
  };
  return [...order].sort((a, b) => rank(b) - rank(a));
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

/**
 * Intencao de DESIGN/UI. Diferente de `kind: ui` (que significa computer use:
 * enxergar e clicar na tela). Aqui a pergunta e: o pedido e sobre aparencia,
 * layout, componentes, acessibilidade visual ou sistema de design?
 *
 * Quando sim, o worker recebe o corpo das skills de UI vendorizadas (skills/ui).
 */
const DESIGN_SIGNALS: ReadonlyArray<{ tag: string; re: RegExp; skills: readonly string[] }> = [
  { tag: "design-md", re: /\b(design\.md|design system|design tokens?|tokens? de design|style ?guide|guia de estilo|identidade visual|biblioteca de componentes)/i, skills: ["create-design-md"] },
  { tag: "accessibility", re: /\b(acessibilidade|a11y|aria|wcag|contraste|leitores? de tela|navegacao por teclado|foco visivel)/i, skills: ["fixing-accessibility"] },
  { tag: "motion", re: /\b(animac|anima[cç][aã]o|transic|motion|jank|stutter|framer|gsap|keyframes|scroll-linked)/i, skills: ["fixing-motion-performance"] },
  { tag: "metadata", re: /\b(seo|meta ?tags?|open ?graph|og:image|twitter card|canonical|json-?ld|favicon|robots\.txt|sitemap)/i, skills: ["fixing-metadata"] },
  { tag: "improve", re: /\b(revis\w*|audit\w*|melhor\w*|polir|polish|refinar|deslop|limpar a interface|ajustar o visual)/i, skills: ["improve-ui", "baseline-ui"] },
  { tag: "canvas", re: /\b(canvas|galeria de componentes|storybook|vitrine de componentes)/i, skills: ["component-canvas", "create-canvas"] },
  { tag: "visual", re: /\b(ui|ux|interface|layout|leiaute|tela|p[aá]gina|landing page|dashboard|formulario|form\b|modal|sidebar|navbar|header|footer|card|botao|bot[aã]o|tab(ela)?s\b|tipografia|fontes?|cores?|paleta|espacamento|padding|margin|responsiv\w*|mobile-first|css|tailwind|sass|styled-components|shadcn|componente|front-?end|mockup|prototip\w*|wireframe)/i, skills: ["baseline-ui"] },
];

export interface DesignIntent {
  /** true quando ha sinal de trabalho visual */
  isDesign: boolean;
  /** tags detectadas, na ordem de especificidade */
  tags: string[];
  /** nomes de skill a injetar (dedup, ordem de prioridade) */
  skills: string[];
}

/** Heuristica sem LLM: decide se o worker precisa do contexto de design. */
export function designIntent(task: string): DesignIntent {
  const texto = (task ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const tags: string[] = [];
  const skills: string[] = [];
  for (const s of DESIGN_SIGNALS) {
    if (!s.re.test(texto)) continue;
    tags.push(s.tag);
    for (const skill of s.skills) if (!skills.includes(skill)) skills.push(skill);
  }
  const isDesign = tags.length > 0;
  // baseline-ui e o piso: qualquer trabalho visual recebe o anti-slop de UI
  if (isDesign && !skills.includes("baseline-ui") && !skills.includes("create-design-md")) {
    skills.unshift("baseline-ui");
  }
  return { isDesign, tags, skills: skills.slice(0, 2) };
}

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
  return { kinds: [...new Set(hits)], reason, needsVision, estimatedInput: inputTokens, explicit };
}

/**
 * Revisao CONDICIONAL. Antes, todo turno de codigo gerava um worker de review em
 * paralelo — que revisava o nada, porque rodava antes de existir diff. Agora review
 * entra quando ha risco real, e o worker recebe o material dos outros (ver runPlan).
 */
const REVIEW_TRIGGER =
  /\b(produ[cç][aã]o|deploy|release|migra[cç][aã]o|schema|auth|autentica|autoriza|permiss|cripto|senha|pagamento|financeir|cobran[cç]a|lgpd|dados de (cliente|usuario)|refator|reescrev|quebr)/i;

export function needsReview(task: string, kinds: readonly TaskKind[], taskChars = 0): { yes: boolean; why: string } {
  if (kinds.includes("review")) return { yes: false, why: "o usuario ja pediu revisao: vira subtarefa propria" };
  if (!kinds.includes("implement") && !kinds.includes("terminal")) {
    return { yes: false, why: "sem alteracao de codigo no plano" };
  }
  if (REVIEW_TRIGGER.test(task)) return { yes: true, why: "tarefa mexe em area de risco (deploy/auth/dados/migracao)" };
  if (taskChars > 600) return { yes: true, why: "pedido longo: superficie de erro grande" };
  return { yes: false, why: "implementacao pequena: revisao nao paga o custo" };
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

/**
 * Indice ULTRA compacto para o prompt do sistema (progressive disclosure):
 * uma linha por modelo, so o que muda a escolha. Detalhe completo mora em action="models".
 */
export function catalogIndex(): string {
  return ALL_MODELS.map((m) => {
    const custo = theosOf(m) > 0 ? ` ${theosOf(m)}theos` : " free";
    return `- ${m.id}${custo} [${laneOf(m)}] (${m.bestFor.join("/")})`;
  }).join("\n");
}

/** Tabela completa (action=models), nao vai no prompt. */
export function catalogTable(): string {
  return ALL_MODELS.map((m) => {
    const tags = [
      m.aa ? `AA ${m.aa}` : undefined,
      m.deepswe ? `DeepSWE ${m.deepswe}` : undefined,
      `${Math.round(m.ctx / 1024)}k ctx`,
      m.textOnly ? "text-only" : "multimodal",
    ]
      .filter(Boolean)
      .join(", ");
    const custo = theosOf(m) > 0 ? `${theosOf(m)} theos/request` : "gratuito";
    return `- ${m.id} (${m.name}, ${m.vendor}) — ${tags} — ${custo} [${laneOf(m)}] — melhor em: ${m.bestFor.join("/")}`;
  }).join("\n");
}
