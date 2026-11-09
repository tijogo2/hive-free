/**
 * free-hive / selfhelp.ts
 *
 * Quando o agente trava, ele para de adivinhar e vai procurar ferramenta.
 *
 *  - searchGithub(): procura repo/ferramenta pronta (GitHub API, sem token por padrao).
 *  - recon(): leitura estatica de um binario/app/.exe/plugin: formato real, secoes,
 *    entropia, imports, marcadores de stack e plano de engenharia reversa (REA).
 *  - escalate(): o fluxo do "estou travado" -> classifica o bloqueio, busca
 *    ferramenta, escreve a licao na memoria (gotcha) e devolve passos acionaveis.
 *
 * Tudo offline/local exceto a busca no GitHub. Nenhuma chamada de modelo.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ------------------------------------------------------------- github search

export interface RepoHit {
  fullName: string;
  url: string;
  stars: number;
  updated: string;
  language?: string;
  description: string;
  archived: boolean;
  score: number;
  install?: string;
}

interface CacheEntry { at: number; data: RepoHit[] }
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 30 * 60_000;

function ghHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "free-hive-plugin",
    "x-github-api-version": "2022-11-28",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function guessInstall(repo: RepoHit): string | undefined {
  const n = repo.fullName.toLowerCase();
  const lang = (repo.language ?? "").toLowerCase();
  if (n.includes("awesome-")) return undefined;
  if (lang === "rust") return `cargo install --git ${repo.url}`;
  if (lang === "go") return `go install ${repo.fullName}@latest`;
  if (lang === "python") return `pipx install ${path.basename(repo.fullName)}  # ou: uv tool install ...`;
  if (lang === "javascript" || lang === "typescript") return `npx ${path.basename(repo.fullName)}  # ou: npm i -g ...`;
  return undefined;
}

/** busca repos no GitHub com ranking honesto (stars, frescor, arquivado, match) */
export async function searchGithub(
  query: string,
  opts: { limit?: number; language?: string; signal?: AbortSignal } = {},
): Promise<RepoHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 15);
  const q = [query, opts.language ? `language:${opts.language}` : ""].filter(Boolean).join(" ");
  const key = `${q}|${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${limit * 2}`;
  const res = await fetch(url, { headers: ghHeaders(), signal: opts.signal ?? AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "GitHub API recusou (403: rate limit). Defina GITHUB_TOKEN ou tente mais tarde."
        : `GitHub API HTTP ${res.status}`,
    );
  }
  const json = (await res.json()) as { items?: Array<Record<string, any>> };
  const now = Date.now();
  const hits: RepoHit[] = (json.items ?? []).map((it) => {
    const stars = Number(it.stargazers_count ?? 0);
    const updated = String(it.pushed_at ?? it.updated_at ?? "");
    const archived = Boolean(it.archived);
    const idadeMeses = updated ? (now - new Date(updated).getTime()) / (30 * 86_400_000) : 60;
    const frescor = Math.max(0, 1 - idadeMeses / 24);
    const desc = String(it.description ?? "");
    const termos = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const match = termos.filter((t) => `${it.full_name} ${desc}`.toLowerCase().includes(t)).length / Math.max(termos.length, 1);
    const score = Math.log10(1 + stars) * 1.2 + frescor * 1.5 + match * 2 - (archived ? 3 : 0);
    const hit: RepoHit = {
      fullName: String(it.full_name ?? ""),
      url: String(it.html_url ?? ""),
      stars,
      updated: updated.slice(0, 10),
      language: it.language ?? undefined,
      description: desc,
      archived,
      score: Math.round(score * 100) / 100,
    };
    hit.install = guessInstall(hit);
    return hit;
  });
  const ranked = hits.sort((a, b) => b.score - a.score).slice(0, limit);
  cache.set(key, { at: now, data: ranked });
  return ranked;
}

// ---------------------------------------------------------------- recon

// A analise estatica vive em ./recon.ts (leitor por arquivo, PE/ELF/asar/ZIP).
export { recon, formatRecon } from "./recon.ts";
export type { ReconReport } from "./recon.ts";

// ---------------------------------------------------------------- escalate

export interface Escalation {
  classification: string;
  diagnosis: string;
  candidates: RepoHit[];
  steps: string[];
  memoryPage?: { type: "gotcha" | "procedure"; title: string; body: string };
}

export type BlockerKind =
  | "tool-missing"
  | "unknown-format"
  | "api-unclear"
  | "build-broken"
  | "perf"
  | "permission"
  | "logic"
  | "unknown";

export function classifyBlocker(blocker: string): BlockerKind {
  const b = blocker.toLowerCase();
  if (/\b(comando|bin[aá]rio|cli|ferramenta|not found|command not found|nao instalad|não instalad|missing|precisa (de|do) (um )?(tool|programa))\b/.test(b)) return "tool-missing";
  if (/\b(formato (desconhecido|estranho)|n[aã]o sei (o|que) (formato|arquivo)|bin[aá]rio|\.exe|\.dll|asar|bytecode|protocolo (bin[aá]rio|fechado)|engenharia reversa|sem c[oó]digo|sem fonte)\b/.test(b)) return "unknown-format";
  if (/\b(api|endpoint|schema|contrato|documenta[cç][aã]o (ruim|ausente)|n[aã]o sei (a|o) (assinatura|retorno))\b/.test(b)) return "api-unclear";
  if (/\b(build|compil|linker|depend[eê]ncia|instalar|vers[aã]o incompat|peer dep|resolve)\b/.test(b)) return "build-broken";
  if (/\b(lento|performance|timeout|mem[oó]ria|estour|vazamento|leak|trava)\b/.test(b)) return "perf";
  if (/\b(permiss[aã]o|access denied|EACCES|EPERM|sandbox|bloqueado)\b/.test(b)) return "permission";
  if (/\b(erro de l[oó]gica|resultado errado|n[aã]o faz o que|comportamento inesperado|teste falha)\b/.test(b)) return "logic";
  return "unknown";
}

const ESCALATION_PLAYBOOK: Record<BlockerKind, { diagnosis: string; query: (b: string) => string; steps: string[] }> = {
  "tool-missing": {
    diagnosis: "Falta uma ferramenta no ambiente. Nao reimplemente do zero: procure a ferramenta certa e instale.",
    query: (b) => `cli tool ${keywords(b)}`,
    steps: [
      "Confirmar o que falta de verdade (`which`/`where`, `--version`) antes de instalar.",
      "Instalar pelo gerenciador do ecossistema (winget/scoop/npm/cargo/pipx/uv) — nunca baixar .exe solto de origem desconhecida.",
      "Rodar `--help` e registrar o comando que resolveu na memoria (procedure).",
    ],
  },
  "unknown-format": {
    diagnosis: "Formato/artefato sem documentacao. Isto e engenharia reversa, nao adivinhacao: leia a estrutura, nao o chute.",
    query: (b) => `${keywords(b)} parser reverse engineering`,
    steps: [
      "Rodar `hive recon <arquivo>` para obter formato real, secoes, entropia e stack detectada.",
      "Achar o parser pronto (libmagic, Kaitai Struct, binwalk, 7z, Malcat, Ghidra) antes de escrever o seu.",
      "Escrever um harness minimo que reproduz o comportamento observado e so entao derivar a solucao.",
    ],
  },
  "api-unclear": {
    diagnosis: "Contrato da API desconhecido. Colete evidencia (trafego, tipos, testes) em vez de supor.",
    query: (b) => `${keywords(b)} api client sdk`,
    steps: [
      "Procurar SDK/client oficial ou tipos publicados antes de montar a chamada na mao.",
      "Capturar uma chamada real (log, mitmproxy) e derivar o schema a partir dela.",
      "Escrever um teste que falha se o contrato mudar.",
    ],
  },
  "build-broken": {
    diagnosis: "Cadeia de build/dependencia quebrada. Isole a camada antes de mexer no codigo.",
    query: (b) => `${keywords(b)} build fix`,
    steps: [
      "Reproduzir em ambiente limpo (`--frozen-lockfile`, `npm ci`) para separar cache de codigo.",
      "Ler o primeiro erro, nao o ultimo: os seguintes costumam ser cascata.",
      "Registrar o par sintoma->correcao na memoria (gotcha).",
    ],
  },
  perf: {
    diagnosis: "Problema de desempenho. Sem medicao nao existe otimizacao.",
    query: (b) => `${keywords(b)} profiler performance`,
    steps: [
      "Medir primeiro: profiler/flamegraph e um baseline numerico reproduzivel.",
      "Otimizar o gargalo medido, um por vez, medindo de novo.",
    ],
  },
  permission: {
    diagnosis: "Bloqueio de permissao/sandbox: o desenho de seguranca esta funcionando. Nao contorne em silencio.",
    query: (b) => `${keywords(b)} permission denied`,
    steps: [
      "Identificar qual processo/usu[aá]rio foi negado e por qual camada (ACL, sandbox, antivirus).",
      "Pedir o escopo minimo necessario em vez de desligar a protecao.",
    ],
  },
  logic: {
    diagnosis: "Erro de logica. Reduza a um caso minimo reproduzivel antes de mudar o desenho.",
    query: (b) => `${keywords(b)} bug test case`,
    steps: [
      "Escrever o teste que falha ANTES de corrigir.",
      "Confirmar a causa raiz com evidencia (log, debugger), nao com plausibilidade.",
    ],
  },
  unknown: {
    diagnosis: "Bloqueio nao classificado. Reduza a incerteza antes de agir.",
    query: (b) => keywords(b),
    steps: [
      "Descrever o bloqueio em uma frase factual, com o erro literal.",
      "Buscar a mensagem de erro literal no GitHub/issue tracker.",
      "Se nada aparecer, decompor o problema e resolver a menor parte incerta.",
    ],
  },
};

function keywords(text: string, n = 6): string {
  const stop = new Set(["que", "com", "para", "uma", "dos", "das", "por", "nao", "não", "erro", "the", "and", "que", "estou", "esta", "está"]);
  return (text.toLowerCase().match(/[a-z0-9_.#+-]{3,}/g) ?? [])
    .filter((w) => !stop.has(w))
    .slice(0, n)
    .join(" ");
}

export async function escalate(
  blocker: string,
  opts: { evidence?: string; language?: string; signal?: AbortSignal; search?: boolean } = {},
): Promise<Escalation> {
  const kind = classifyBlocker(blocker);
  const play = ESCALATION_PLAYBOOK[kind];
  let candidates: RepoHit[] = [];
  const warnings: string[] = [];
  if (opts.search !== false) {
    // Duas tentativas: a consulta do playbook e, se voltar vazia, uma mais curta com a
    // extensao do arquivo citado (ex.: .asar, .exe) — a segunda costuma acertar.
    const ext = (blocker.match(/\.[a-z0-9]{2,5}\b/i) ?? [])[0]?.replace(/^\./, "").toLowerCase();
    const consultas = [play.query(blocker), ext ? `${ext} extract tool` : `${keywords(blocker, 3)} tool`];
    for (const q of consultas) {
      if (!q.trim()) continue;
      try {
        const found = await searchGithub(q, { limit: 5, language: opts.language, signal: opts.signal });
        if (found.length) { candidates = found; break; }
      } catch (error) {
        warnings.push(String((error as Error)?.message ?? error));
        break;
      }
    }
  }
  const steps = [...play.steps];
  if (candidates.length) {
    steps.push(`Candidato mais forte: ${candidates[0].fullName} (★${candidates[0].stars}) — ${candidates[0].url}`);
  }
  return {
    classification: kind,
    diagnosis: play.diagnosis,
    candidates,
    steps: [...steps, ...warnings.map((w) => `aviso: ${w}`)],
    memoryPage: {
      type: "gotcha",
      title: `Bloqueio: ${blocker.slice(0, 60)}`,
      body: [
        `Tipo: ${kind}`,
        opts.evidence ? `\nEvidencia:\n${opts.evidence}` : "",
        `\nDiagnostico: ${play.diagnosis}`,
        `\nComo sair:\n${play.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        candidates.length ? `\nFerramentas avaliadas:\n${candidates.map((c) => `- ${c.fullName} (★${c.stars}, ${c.updated}) ${c.url}`).join("\n")}` : "",
      ].filter(Boolean).join("\n"),
    },
  };
}

export function formatEscalation(e: Escalation): string {
  const L: string[] = [];
  L.push(`# Auto-socorro — bloqueio: ${e.classification}`);
  L.push(e.diagnosis, "");
  L.push("## Passos");
  for (const s of e.steps) L.push(`- ${s}`);
  if (e.candidates.length) {
    L.push("", "## Ferramentas encontradas no GitHub");
    for (const c of e.candidates) {
      L.push(`- ${c.fullName} ★${c.stars} · ${c.language ?? "?"} · atualizado ${c.updated}${c.archived ? " · ARQUIVADO" : ""}`);
      L.push(`  ${c.description || "(sem descricao)"}`);
      L.push(`  ${c.url}${c.install ? `\n  instalar: ${c.install}` : ""}`);
    }
  }
  return L.join("\n");
}
