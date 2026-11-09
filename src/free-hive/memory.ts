/**
 * free-hive / memory.ts
 *
 * Memoria de longo prazo no espirito do ai-memory 2.0 (akitaonrails), reimplementada
 * local, offline e com ZERO chamadas de modelo no caminho padrao:
 *
 *   captura -> consolidacao -> recall -> handoff
 *
 * Invariantes copiadas do ai-memory 2.0:
 *  1. A verdade e markdown em disco (OKF-like): frontmatter com type / provenance /
 *     stale_after / relations / valid_from / valid_to. Grepavel, editavel a mao.
 *  2. O indice e derivado e pode ser reconstruido das paginas a qualquer momento
 *     (`rebuild()`), nunca e fonte de verdade.
 *  3. Recall hibrido fundido: lexical (BM25) + semantico (hash de n-gramas, sem
 *     download de modelo) + grafo (wikilinks/relations) + entidades, com fusao RRF.
 *  4. Tempo: `as_of` responde "o que sabiamos sobre X naquele momento" filtrando
 *     janelas de validade (bi-temporal-lite, grao de ingestao).
 *  5. Retencao ponderada por acesso: pagina usada decai mais devagar (uses/last_used).
 *  6. Handoff e protocolo tipado: tem dono e e reivindicado exatamente uma vez.
 *  7. Lint de contradicao sem LLM: `relations.contradicts` e o proprio sinal.
 *  8. Nada e apagado: supersedida vira versao anterior (`_versions/`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export type PageType =
  | "decision"
  | "gotcha"
  | "procedure"
  | "note"
  | "handoff"
  | "episode"
  | "model-profile";

export const PAGE_TYPES: readonly PageType[] = [
  "decision",
  "gotcha",
  "procedure",
  "note",
  "handoff",
  "episode",
  "model-profile",
];

/** meia-vida por tipo, em dias (retencao/decay) */
const TTL_DAYS: Record<PageType, number> = {
  decision: 365,
  gotcha: 180,
  procedure: 180,
  note: 90,
  handoff: 30,
  episode: 45,
  "model-profile": 120,
};

export interface Relations {
  causes?: string[];
  fixes?: string[];
  contradicts?: string[];
  supersedes?: string[];
}

export interface Page {
  /** caminho relativo ao root, com .md */
  rel: string;
  type: PageType;
  title: string;
  body: string;
  created: string;
  validFrom: string;
  validTo?: string;
  staleAfter: string;
  tags: string[];
  sources: string[];
  relations: Relations;
  uses: number;
  lastUsed?: string;
  owner?: string;
  status?: string;
  /** pagina sintetica usada para o briefing */
  summary?: string;
}

export interface QueryHit {
  rel: string;
  title: string;
  type: PageType;
  score: number;
  snippet: string;
  stale: boolean;
  uses: number;
}

export interface WriteInput {
  type: PageType;
  title: string;
  body: string;
  tags?: string[];
  sources?: string[];
  relations?: Relations;
  /** id/titulo de pagina que esta substitui */
  supersedes?: string;
}

// ---------------------------------------------------------------- utilidades

const STOP = new Set(
  ("a o e de da do das dos que em um uma para por com nao sim se ao aos as os no na nos nas " +
    "the a an and or of to in on for with is are was were be been it its this that these those " +
    "como mais muito quando onde qual quais sobre entre ja foi ser seu sua eu voce").split(/\s+/),
);

export function slugify(s: string, max = 48): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "sem-titulo";
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_\u00c0-\u024f]{2,}/gi) ?? [])
    .filter((t) => !STOP.has(t));
}

/** vetor hasheado de n-gramas de caractere: substituto local de embedding */
const VEC_DIM = 256;
function embed(text: string): Float32Array {
  const v = new Float32Array(VEC_DIM);
  const clean = " " + text.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/gi, " ").trim() + " ";
  const words = clean.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const padded = `#${w}#`;
    for (let i = 0; i + 4 <= padded.length; i++) {
      const g = padded.slice(i, i + 4);
      let h = 2166136261;
      for (let j = 0; j < g.length; j++) {
        h ^= g.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % VEC_DIM] += 1;
    }
  }
  let norm = 0;
  for (let i = 0; i < VEC_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < VEC_DIM; i++) v[i] /= norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < VEC_DIM; i++) s += a[i] * b[i];
  return s;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

function isStale(p: Page, at = new Date()): boolean {
  return new Date(p.staleAfter).getTime() < at.getTime();
}

// ------------------------------------------------------------- frontmatter

const FM_KEYS = new Set([
  "type", "title", "created", "valid_from", "valid_to", "stale_after",
  "tags", "sources", "relations", "uses", "last_used", "owner", "status", "summary",
]);

function inlineList(raw: string): string[] {
  const m = raw.trim().match(/^\[(.*)\]$/);
  const inner = m ? m[1] : raw;
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function renderPage(p: Page): string {
  const L: string[] = ["---"];
  L.push(`type: ${p.type}`);
  L.push(`title: ${p.title.replace(/\n/g, " ")}`);
  L.push(`created: ${p.created}`);
  L.push(`valid_from: ${p.validFrom}`);
  if (p.validTo) L.push(`valid_to: ${p.validTo}`);
  L.push(`stale_after: ${p.staleAfter}`);
  L.push(`tags: [${p.tags.join(", ")}]`);
  L.push(`sources: [${p.sources.map((s) => JSON.stringify(s)).join(", ")}]`);
  const rel = p.relations ?? {};
  const relLines = Object.entries(rel).filter(([, v]) => v && v.length);
  if (relLines.length) {
    L.push("relations:");
    for (const [k, v] of relLines) L.push(`  ${k}: [${(v as string[]).join(", ")}]`);
  } else {
    L.push("relations: {}");
  }
  L.push(`uses: ${p.uses}`);
  if (p.lastUsed) L.push(`last_used: ${p.lastUsed}`);
  if (p.owner) L.push(`owner: ${p.owner}`);
  if (p.status) L.push(`status: ${p.status}`);
  if (p.summary) L.push(`summary: ${JSON.stringify(p.summary)}`);
  L.push("---");
  return `${L.join("\n")}\n${p.body.trim()}\n`;
}

export function parsePage(rel: string, raw: string): Page | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return undefined;
  const [, head, body] = m;
  const get = (k: string): string | undefined => {
    const line = head.split(/\r?\n/).find((l) => l.startsWith(`${k}:`));
    return line ? line.slice(k.length + 1).trim() : undefined;
  };
  const type = (get("type") ?? "note") as PageType;
  const relations: Relations = {};
  const relBlock = head.match(/relations:\s*\r?\n((?:\s+[a-z_]+:.*\r?\n?)+)/);
  if (relBlock) {
    for (const line of relBlock[1].split(/\r?\n/)) {
      const kv = line.trim().match(/^([a-z_]+):\s*(.*)$/);
      if (kv) (relations as Record<string, string[]>)[kv[1]] = inlineList(kv[2]);
    }
  }
  const created = get("created") ?? nowIso();
  let title = get("title") ?? path.basename(rel, ".md");
  title = title.replace(/^"(.*)"$/, "$1");
  let summary = get("summary");
  if (summary) {
    try { summary = JSON.parse(summary); } catch { /* deixa cru */ }
  }
  return {
    rel,
    type: PAGE_TYPES.includes(type) ? type : "note",
    title,
    body: body ?? "",
    created,
    validFrom: get("valid_from") ?? created,
    validTo: get("valid_to") || undefined,
    staleAfter: get("stale_after") ?? addDays(created, TTL_DAYS.note),
    tags: inlineList(get("tags") ?? ""),
    sources: inlineList(get("sources") ?? ""),
    relations,
    uses: Number(get("uses") ?? 0) || 0,
    lastUsed: get("last_used") || undefined,
    owner: get("owner") || undefined,
    status: get("status") || undefined,
    summary: typeof summary === "string" ? summary : undefined,
  };
}

// ------------------------------------------------------------------- store

interface IndexedPage {
  page: Page;
  tf: Map<string, number>;
  len: number;
  vec: Float32Array;
  tokens: Set<string>;
}

export interface StoreOptions {
  /** raiz da memoria; default ~/.deepai-code/free-hive */
  root?: string;
  /** identidade do projeto (nome do checkout, nao caminho absoluto) */
  project: string;
  /** quem esta escrevendo (instancia, nao pessoa) */
  actor?: string;
}

export function defaultRoot(): string {
  return process.env.HIVE_MEMORY_DIR || path.join(os.homedir(), ".deepai-code", "free-hive");
}

/** identidade do projeto pelo nome do checkout, como o ai-memory faz */
export function projectName(cwd: string): string {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) { dir = path.resolve(cwd); break; }
    dir = parent;
  }
  return slugify(path.basename(dir) || "global");
}

/** chave tolerante: slug do nome do arquivo sem pasta e sem extensao */
export function normKey(s: string): string {
  const base = String(s).replace(/\.md$/i, "").split("/").filter(Boolean).pop() ?? "";
  return slugify(base);
}

export class MemoryStore {
  readonly root: string;
  readonly project: string;
  readonly actor: string;
  readonly dir: string;
  private pages: IndexedPage[] = [];
  private loaded = false;
  private loadedAt = 0;
  private df = new Map<string, number>();
  private avgLen = 0;
  private lockChain: Promise<unknown> = Promise.resolve();

  constructor(opts: StoreOptions) {
    this.root = opts.root ?? defaultRoot();
    this.project = opts.project;
    this.actor = opts.actor ?? "free-hive";
    this.dir = path.join(this.root, "projects", this.project);
  }

  get pagesDir(): string {
    return path.join(this.dir, "pages");
  }

  get versionsDir(): string {
    return path.join(this.dir, "pages", "_versions");
  }

  ensure(): void {
    fs.mkdirSync(this.pagesDir, { recursive: true });
    fs.mkdirSync(this.versionsDir, { recursive: true });
  }

  /** serializa escritas no mesmo processo e entre processos (lockfile) */
  private async locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lockChain.then(async () => {
      this.ensure();
      const lockPath = path.join(this.dir, ".write.lock");
      const deadline = Date.now() + 5_000;
      const started = Date.now();
      let fd: number | undefined;
      while (fd === undefined) {
        try {
          fd = fs.openSync(lockPath, "wx");
          fs.writeSync(fd, String(process.pid));
        } catch {
          if (Date.now() - started > 3_000) {
            // lock orfao de um processo que morreu: libera e tenta de novo
            try { fs.unlinkSync(lockPath); } catch { /* alguem ja liberou */ }
          }
          if (Date.now() > deadline) throw new Error("memory: lock de escrita indisponivel");
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      try {
        return await fn();
      } finally {
        try { fs.closeSync(fd!); } catch { /* ignore */ }
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      }
    });
    this.lockChain = run.catch(() => undefined);
    return run;
  }

  private walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_versions") continue;
        this.walk(full, out);
      } else if (entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
    return out;
  }

  /** reconstroi o indice derivado a partir dos arquivos (nunca e fonte de verdade) */
  load(force = false): void {
    // Paginas sao markdown editavel a mao e outras sessoes escrevem no mesmo diretorio:
    // reindexa a cada RECARGA_MS em vez de confiar num snapshot eterno.
    const RECARGA_MS = 5_000;
    if (this.loaded && !force && Date.now() - this.loadedAt < RECARGA_MS) return;
    this.ensure();
    const files = this.walk(this.pagesDir);
    const pages: IndexedPage[] = [];
    for (const file of files) {
      let raw: string;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      const rel = path.relative(this.pagesDir, file).replace(/\\/g, "/");
      const page = parsePage(rel, raw);
      if (!page) continue;
      const text = `${page.title} ${page.tags.join(" ")} ${page.body}`;
      const toks = tokens(text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      pages.push({ page, tf, len: toks.length, vec: embed(text), tokens: new Set(toks) });
    }
    this.pages = pages;
    this.df = new Map();
    let total = 0;
    for (const p of pages) {
      total += p.len;
      for (const t of p.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = pages.length ? total / pages.length : 1;
    this.loaded = true;
    this.loadedAt = Date.now();
    try {
      fs.writeFileSync(
        path.join(this.dir, "index-meta.json"),
        JSON.stringify({ project: this.project, pages: pages.length, rebuiltAt: nowIso() }, null, 2),
      );
    } catch { /* indice e descartavel */ }
  }

  all(): Page[] {
    this.load();
    return this.pages.map((p) => p.page);
  }

  find(needle: string): Page | undefined {
    this.load();
    const n = normKey(needle);
    return (
      this.pages.find((p) => normKey(p.page.rel) === n)?.page ??
      this.pages.find((p) => normKey(p.page.title) === n)?.page ??
      this.pages.find((p) => normKey(p.page.rel).includes(n) || normKey(p.page.title).includes(n))?.page
    );
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  }

  /** grava pagina; deduplica quase-identicas e versiona supersedidas */
  async write(input: WriteInput, opts: { dedupe?: boolean } = {}): Promise<{ page: Page; action: "created" | "merged" | "superseded" }> {
    return this.locked(() => {
      this.load(true);
      const dedupe = opts.dedupe !== false;
      const text = `${input.title} ${input.body} ${(input.tags ?? []).join(" ")}`;
      const toks = new Set(tokens(text));
      const vec = embed(text);

      if (dedupe) {
        for (const cand of this.pages) {
          if (cand.page.type !== input.type) continue;
          if (cand.page.validTo) continue;
          const jac = this.jaccard(toks, cand.tokens);
          const cos = cosine(vec, cand.vec);
          if (jac >= 0.85 || (jac >= 0.6 && cos >= 0.9)) {
            const p = cand.page;
            p.uses += 1;
            p.lastUsed = nowIso();
            p.staleAfter = addDays(nowIso(), TTL_DAYS[p.type]);
            if (input.sources?.length) {
              p.sources = [...new Set([...p.sources, ...input.sources])].slice(-12);
            }
            fs.writeFileSync(path.join(this.pagesDir, p.rel), renderPage(p));
            this.load(true);
            return { page: p, action: "merged" as const };
          }
        }
      }

      // versiona a(s) pagina(s) substituida(s)
      const superseded: Page[] = [];
      for (const target of input.relations?.supersedes ?? []) {
        const old = this.find(target);
        if (!old || old.validTo) continue;
        old.validTo = nowIso();
        fs.writeFileSync(path.join(this.pagesDir, old.rel), renderPage(old));
        const backup = path.join(this.versionsDir, `${old.rel.replace(/\.md$/, "")}@${Date.now()}.md`);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        try { fs.copyFileSync(path.join(this.pagesDir, old.rel), backup); } catch { /* opcional */ }
        superseded.push(old);
      }

      const ts = nowIso();
      const rel = `${input.type}/${slugify(input.title)}.md`;
      const page: Page = {
        rel,
        type: input.type,
        title: input.title,
        body: input.body,
        created: ts,
        validFrom: ts,
        staleAfter: addDays(ts, TTL_DAYS[input.type]),
        tags: input.tags ?? [],
        sources: input.sources ?? [],
        relations: input.relations ?? {},
        uses: 0,
        owner: input.type === "handoff" ? this.actor : undefined,
        status: input.type === "handoff" ? "open" : undefined,
      };
      const full = path.join(this.pagesDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, renderPage(page));
      this.load(true);
      return { page, action: superseded.length ? ("superseded" as const) : ("created" as const) };
    });
  }

  markUsed(rels: readonly string[]): void {
    if (!rels.length) return;
    try {
      for (const rel of rels) {
        const p = this.pages.find((x) => x.page.rel === rel)?.page;
        if (!p) continue;
        p.uses += 1;
        p.lastUsed = nowIso();
        fs.writeFileSync(path.join(this.pagesDir, p.rel), renderPage(p));
      }
    } catch { /* metrica nao pode quebrar recall */ }
  }

  /** janela de validade (grao de ingestao): vale se ja existia e nao foi substituida */
  private liveAt(p: Page, at: Date): boolean {
    if (new Date(p.validFrom).getTime() > at.getTime()) return false;
    if (p.validTo && new Date(p.validTo).getTime() <= at.getTime()) return false;
    return true;
  }

  /** BM25 lexical */
  private lexical(qToks: string[], at: Date): Map<string, number> {
    const N = this.pages.length || 1;
    const k1 = 1.2;
    const b = 0.75;
    const out = new Map<string, number>();
    for (const p of this.pages) {
      if (!this.liveAt(p.page, at)) continue;
      let score = 0;
      for (const t of qToks) {
        const f = p.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (p.len / (this.avgLen || 1)))));
      }
      if (score > 0) out.set(p.page.rel, score);
    }
    return out;
  }

  private semantic(qvec: Float32Array, at: Date): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of this.pages) {
      if (!this.liveAt(p.page, at)) continue;
      const s = cosine(qvec, p.vec);
      if (s > 0.08) out.set(p.page.rel, s);
    }
    return out;
  }

  /** expande por grafo: wikilinks + relations */
  private graph(seedRels: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    const byTitle = new Map(this.pages.map((p) => [slugify(p.page.title), p.page.rel]));
    for (const rel of seedRels) {
      const p = this.pages.find((x) => x.page.rel === rel)?.page;
      if (!p) continue;
      const targets = new Set<string>();
      for (const m of p.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const t = byTitle.get(slugify(m[1]));
        if (t) targets.add(t);
      }
      for (const list of Object.values(p.relations ?? {})) {
        for (const t of list ?? []) {
          const found = this.pages.find((x) => x.page.rel === t || slugify(x.page.title) === slugify(t));
          if (found) targets.add(found.page.rel);
        }
      }
      for (const t of targets) {
        if (t === rel) continue;
        out.set(t, Math.max(out.get(t) ?? 0, 0.5));
      }
    }
    return out;
  }

  /** recall hibrido com fusao RRF + bonus de frescor/uso */
  query(text: string, opts: { asOf?: string; types?: readonly PageType[]; limit?: number; includeStale?: boolean } = {}): QueryHit[] {
    this.load();
    const at = opts.asOf ? new Date(opts.asOf) : new Date();
    if (Number.isNaN(at.getTime())) throw new Error(`as_of invalido: ${opts.asOf}`);
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 40);
    const qToks = tokens(text);
    const streams: Array<Map<string, number>> = [
      this.lexical(qToks, at),
      this.semantic(embed(text), at),
    ];

    const rank = (m: Map<string, number>): string[] =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

    const fused = new Map<string, number>();
    const K = 60;
    streams.forEach((s) => {
      rank(s).forEach((rel, i) => fused.set(rel, (fused.get(rel) ?? 0) + 1 / (K + i + 1)));
    });
    // grafo: expande a partir dos melhores do stream lexical (peso menor que os streams diretos)
    const seeds = rank(streams[0]).slice(0, 3);
    rank(this.graph(seeds)).forEach((rel, i) => {
      fused.set(rel, (fused.get(rel) ?? 0) + 0.3 * (1 / (K + i + 1)));
    });

    const hits: QueryHit[] = [];
    for (const [rel, base] of fused) {
      const p = this.pages.find((x) => x.page.rel === rel)?.page;
      if (!p) continue;
      if (!this.liveAt(p, at)) continue;
      if (opts.types?.length && !opts.types.includes(p.type)) continue;
      const stale = isStale(p, at);
      if (stale && opts.includeStale === false) continue;
      // retencao ponderada por acesso: uso recente segura a pagina viva
      const usado = p.uses > 0 ? 1 + Math.min(0.35, Math.log1p(p.uses) / 8) : 1;
      const idadeDias = (Date.now() - new Date(p.created).getTime()) / 86_400_000;
      const frescor = idadeDias < 7 ? 1.15 : idadeDias < 30 ? 1.05 : 1;
      const score = base * usado * (stale ? 0.85 : 1) * frescor;
      hits.push({ rel, title: p.title, type: p.type, score, snippet: snippet(p), stale, uses: p.uses });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** briefing bounded de inicio de sessao (o que o proximo agente precisa saber) */
  brief(limit = 10): string {
    this.load();
    const live = this.pages.map((p) => p.page).filter((p) => !p.validTo);
    const openHandoffs = live.filter((p) => p.type === "handoff" && (p.status ?? "open") !== "claimed");
    const decisions = live.filter((p) => p.type === "decision").slice(-5);
    const gotchas = live.filter((p) => p.type === "gotcha").slice(-5);
    const procedures = live.filter((p) => p.type === "procedure").slice(-4);
    const stale = live.filter((p) => isStale(p));
    const lines: string[] = [];
    lines.push(`Projeto: ${this.project} · ${live.length} paginas vivas · ${stale.length} vencidas`);
    if (openHandoffs.length) {
      lines.push("", "Handoffs abertos:");
      for (const h of openHandoffs.slice(0, limit)) {
        lines.push(`- [${h.rel}] ${h.title}${h.owner ? ` (dono: ${h.owner})` : ""}`);
      }
    }
    const sec = (label: string, list: Page[]) => {
      if (!list.length) return;
      lines.push("", `${label}:`);
      for (const p of list) lines.push(`- [${p.rel}] ${p.title}`);
    };
    sec("Decisoes", decisions);
    sec("Gotchas", gotchas);
    sec("Procedimentos", procedures);
    if (stale.length) {
      lines.push("", "Vencidas (valide antes de usar):");
      for (const p of stale.slice(0, 5)) lines.push(`- [${p.rel}] ${p.title}`);
    }
    return lines.join("\n");
  }

  /** lint sem LLM: contradicoes declaradas, vencidas, duplicatas, orfas */
  lint(): string[] {
    this.load();
    const out: string[] = [];
    const live = this.pages.map((p) => p.page).filter((p) => !p.validTo);
    const byKey = new Map<string, Page>();
    for (const p of live) {
      byKey.set(p.rel, p);
      byKey.set(slugify(p.title), p);
      byKey.set(normKey(p.rel), p);
    }
    for (const p of live) {
      for (const other of p.relations.contradicts ?? []) {
        const t = byKey.get(other) ?? byKey.get(normKey(other));
        if (!t || t.rel === p.rel) continue;
        const reconciled =
          (t.relations.fixes ?? []).some((f) => f === p.rel || normKey(f) === normKey(p.rel)) ||
          (p.relations.fixes ?? []).some((f) => f === t.rel || normKey(f) === normKey(t.rel));
        if (!reconciled) out.push(`contradicao: ${p.rel} contradiz ${t.rel} (ninguem resolveu)`);
      }
    }
    const stale = live.filter((p) => isStale(p));
    if (stale.length) out.push(`${stale.length} paginas vencidas: ${stale.slice(0, 5).map((p) => p.rel).join(", ")}`);
    // duplicatas
    let dups = 0;
    for (let i = 0; i < this.pages.length && dups < 10; i++) {
      for (let j = i + 1; j < this.pages.length && dups < 10; j++) {
        const a = this.pages[i];
        const b = this.pages[j];
        if (a.page.validTo || b.page.validTo) continue;
        if (a.page.type !== b.page.type) continue;
        if (this.jaccard(a.tokens, b.tokens) >= 0.75) {
          out.push(`duplicata provavel: ${a.page.rel} ~ ${b.page.rel}`);
          dups++;
        }
      }
    }
    // orfas
    const linked = new Set<string>();
    for (const p of live) {
      for (const m of p.body.matchAll(/\[\[([^\]]+)\]\]/g)) linked.add(slugify(m[1]));
      for (const list of Object.values(p.relations ?? {})) for (const t of list ?? []) linked.add(slugify(t));
    }
    for (const p of live) {
      if (p.uses > 0) continue;
      if (linked.has(slugify(p.title)) || linked.has(p.rel)) continue;
      if (Date.now() - new Date(p.created).getTime() < 30 * 86_400_000) continue;
      out.push(`orfa: ${p.rel} (sem link, sem uso, >30d)`);
    }
    return out.length ? out : ["limpo: nenhuma inconsistencia encontrada"];
  }

  // ---------------------------------------------------------- handoffs

  async handoffOpen(input: { title: string; body: string; tags?: string[] }): Promise<Page> {
    const { page } = await this.write({ type: "handoff", ...input }, { dedupe: false });
    return page;
  }

  /** reivindica exatamente uma vez: O_EXCL no arquivo de claim */
  claimHandoff(needle: string, claimedBy: string): { ok: boolean; page?: Page; reason?: string } {
    const p = this.find(needle);
    if (!p) return { ok: false, reason: `handoff nao encontrado: ${needle}` };
    if (p.type !== "handoff") return { ok: false, reason: `${p.rel} nao e um handoff` };
    if ((p.status ?? "open") === "claimed") return { ok: false, reason: `ja reivindicado por ${p.owner ?? "?"}` };
    const claimPath = path.join(this.dir, "claims", `${slugify(p.title)}.claim`);
    fs.mkdirSync(path.dirname(claimPath), { recursive: true });
    try {
      const fd = fs.openSync(claimPath, "wx");
      fs.writeSync(fd, JSON.stringify({ by: claimedBy, at: nowIso() }));
      fs.closeSync(fd);
    } catch {
      return { ok: false, reason: "claim concorrente: outra sessao chegou primeiro" };
    }
    p.status = "claimed";
    p.owner = claimedBy;
    p.validTo = undefined;
    fs.writeFileSync(path.join(this.pagesDir, p.rel), renderPage(p));
    this.load(true);
    return { ok: true, page: p };
  }
}

function snippet(p: Page): string {
  const clean = p.body.replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\s+/g, " ").trim();
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

export function memoryStats(store: MemoryStore): string {
  const all = store.all();
  const live = all.filter((p) => !p.validTo);
  const byType = new Map<PageType, number>();
  for (const p of live) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  const types = [...byType.entries()].map(([t, n]) => `${t}=${n}`).join(" ");
  const stale = live.filter((p) => isStale(p)).length;
  return `memoria: ${store.dir}\n  vivas=${live.length} (${types}) vencidas=${stale} arquivadas=${all.length - live.length}`;
}

/** hash curto estavel, para id de sessao/ator */
export function shortHash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
}
