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
import { auditAppend, redactSecrets } from "./security.ts";
import type { ModelVerdict, TaskKind } from "./catalog.ts";

const HIVE_SOURCE = "desempenho";

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
  /** resumo de uma linha (progressive disclosure): aparece no briefing antes do corpo */
  summary?: string;
}

export interface QueryHit {
  rel: string;
  title: string;
  type: PageType;
  score: number;
  snippet: string;
  /** resumo de uma linha da pagina, quando existe */
  summary?: string;
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
  /** resumo de uma linha exibido no briefing/busca; corpo so carrega sob demanda */
  summary?: string;
}

// ---------------------------------------------------------------- utilidades

const STOP = new Set(
  ("a o e de da do das dos que em um uma para por com nao sim se ao aos as os no na nos nas " +
    "the a an and or of to in on for with is are was were be been it its this that these those " +
    "como mais muito quando onde qual quais sobre entre ja foi ser seu sua eu voce").split(/\s+/),
);

/** limites defensivos: pagina gigante vira contexto gigante na proxima sessao */
const MAX_TITLE = 200;
const MAX_BODY = 200_000;
const MAX_TAGS = 32;
const MAX_TAG_LEN = 64;
const MAX_SOURCES = 24;
const MAX_SUMMARY = 240;

/**
 * sanitiza escalar que vai para o frontmatter: quebra de linha/controle aqui
 * seria injecao de chaves (ex.: tag com " + "\n" + " e " + "valid_to:" fabricaria validade falsa).
 */
function frontmatterSafe(s: string, max = 200): string {
  return String(s).replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

/** escrita atomica: leitor nunca ve arquivo pela metade */
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

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
  L.push(`title: ${frontmatterSafe(p.title, MAX_TITLE)}`);
  L.push(`created: ${p.created}`);
  L.push(`valid_from: ${p.validFrom}`);
  if (p.validTo) L.push(`valid_to: ${p.validTo}`);
  L.push(`stale_after: ${p.staleAfter}`);
  L.push(`tags: [${p.tags.map((t) => frontmatterSafe(t, MAX_TAG_LEN)).join(", ")}]`);
  L.push(`sources: [${p.sources.map((s) => JSON.stringify(frontmatterSafe(s, 300))).join(", ")}]`);
  const rel = p.relations ?? {};
  const relLines = Object.entries(rel).filter(([, v]) => v && v.length);
  if (relLines.length) {
    L.push("relations:");
    for (const [k, v] of relLines) L.push(`  ${k}: [${(v as string[]).map((t) => frontmatterSafe(t, 120)).join(", ")}]`);
  } else {
    L.push("relations: {}");
  }
  L.push(`uses: ${p.uses}`);
  if (p.lastUsed) L.push(`last_used: ${p.lastUsed}`);
  if (p.owner) L.push(`owner: ${frontmatterSafe(p.owner, 120)}`);
  if (p.status) L.push(`status: ${frontmatterSafe(p.status, 40)}`);
  if (p.summary) L.push(`summary: ${JSON.stringify(frontmatterSafe(p.summary, MAX_SUMMARY))}`);
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

interface CacheEntry {
  mtimeMs: number;
  size: number;
  entry: IndexedPage;
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
/** o processo dono do lock ainda existe? (kill(pid, 0) nao mata, so consulta) */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = processo existe mas nao e nosso; so ESRCH prova morte
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** lock so e roubado se o dono esta morto ou se o arquivo passou de 60s sem refresh */
function lockOwnerIsDeadOrStale(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? "", 10);
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (Number.isInteger(pid) && pidAlive(pid) && ageMs < 60_000) return false;
    return true;
  } catch {
    return true; // lock ilegivel/desaparecido: pode ser removido
  }
}

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
  private cache = new Map<string, CacheEntry>();
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
      let fd: number | undefined;
      while (fd === undefined) {
        try {
          fd = fs.openSync(lockPath, "wx");
          fs.writeSync(fd, `${process.pid} ${Date.now()}`);
        } catch {
          // so quebra o lock se o dono estiver MORTO (PID sem processo vivo)
          // ou se o lock for velho demais para ser legitimo. Lock de processo
          // vivo nunca e roubado.
          const stale = lockOwnerIsDeadOrStale(lockPath);
          if (stale) {
            try { fs.unlinkSync(lockPath); } catch { /* alguem ja liberou */ }
          }
          if (Date.now() > deadline) throw new Error("memory: lock de escrita indisponivel (dono vivo? veja .write.lock)");
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
    const seen = new Set<string>();
    const pages: IndexedPage[] = [];
    let reparsed = 0;
    for (const file of files) {
      seen.add(file);
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      // so reparsa/embeda o que mudou: pagina intocada reaproveita o indice
      const hit = this.cache.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        pages.push(hit.entry);
        continue;
      }
      reparsed++;
      let raw: string;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      const rel = path.relative(this.pagesDir, file).replace(/\\/g, "/");
      const page = parsePage(rel, raw);
      if (!page) continue;
      const text = `${page.title} ${page.tags.join(" ")} ${page.body}`;
      const toks = tokens(text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      const entry: IndexedPage = { page, tf, len: toks.length, vec: embed(text), tokens: new Set(toks) };
      this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
      pages.push(entry);
    }
    for (const key of [...this.cache.keys()]) {
      if (!seen.has(key)) { this.cache.delete(key); reparsed++; }
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
    // meta e derivado/derivavel: so regrava quando o indice realmente mudou
    if (reparsed > 0) {
      try {
        fs.writeFileSync(
          path.join(this.dir, "index-meta.json"),
          JSON.stringify({ project: this.project, pages: pages.length, rebuiltAt: nowIso() }, null, 2),
        );
      } catch { /* indice e descartavel */ }
    }
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
      // entradas vindas da ferramenta sao nao-confiaveis: tipo e frontmatter sanitizados
      const type: PageType = PAGE_TYPES.includes(input.type) ? input.type : "note";
      // entrada e nao-confiavel: segredos sao redigidos ANTES de tocar o disco
      const title = frontmatterSafe(redactSecrets(input.title), MAX_TITLE);
      const body = redactSecrets(String(input.body ?? ""));
      if (!title) throw new Error("memory: titulo vazio apos sanitizacao");
      if (body.length > MAX_BODY) throw new Error(`memory: corpo excede ${MAX_BODY} caracteres (recorte antes de gravar)`);
      const tags = (input.tags ?? []).slice(0, MAX_TAGS).map((t) => frontmatterSafe(t, MAX_TAG_LEN)).filter(Boolean);
      const sources = (input.sources ?? []).slice(0, MAX_SOURCES).map((s) => frontmatterSafe(s, 300)).filter(Boolean);
      const relations: Relations = {};
      for (const [k, v] of Object.entries(input.relations ?? {})) {
        if (!v?.length) continue;
        (relations as Record<string, string[]>)[k] = v.slice(0, 24).map((t) => frontmatterSafe(t, 120)).filter(Boolean);
      }
      const summary = input.summary ? frontmatterSafe(input.summary, MAX_SUMMARY) : undefined;
      const dedupe = opts.dedupe !== false;
      const text = `${title} ${body} ${tags.join(" ")}`;
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
              p.sources = [...new Set([...p.sources, ...sources])].slice(-12);
            }
            writeAtomic(path.join(this.pagesDir, p.rel), renderPage(p));
            this.load(true);
            return { page: p, action: "merged" as const };
          }
        }
      }

      // versiona a(s) pagina(s) substituida(s)
      const superseded: Page[] = [];
      for (const target of relations.supersedes ?? []) {
        const old = this.find(target);
        if (!old || old.validTo) continue;
        old.validTo = nowIso();
        writeAtomic(path.join(this.pagesDir, old.rel), renderPage(old));
        const backup = path.join(this.versionsDir, `${old.rel.replace(/\.md$/, "")}@${Date.now()}.md`);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        try { fs.copyFileSync(path.join(this.pagesDir, old.rel), backup); } catch { /* opcional */ }
        superseded.push(old);
      }

      const ts = nowIso();
      const rel = `${type}/${slugify(title)}.md`;
      const page: Page = {
        rel,
        type,
        title,
        body,
        created: ts,
        validFrom: ts,
        staleAfter: addDays(ts, TTL_DAYS[type]),
        tags,
        sources,
        relations,
        uses: 0,
        summary,
        owner: type === "handoff" ? this.actor : undefined,
        status: type === "handoff" ? "open" : undefined,
      };
      const full = path.join(this.pagesDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      writeAtomic(full, renderPage(page));
      auditAppend(this.dir, {
        event: superseded.length ? "memory.supersede" : "memory.create",
        rel,
        type,
        actor: this.actor,
        superseded: superseded.map((s) => s.rel),
      });
      this.load(true);
      return { page, action: superseded.length ? ("superseded" as const) : ("created" as const) };
    });
  }

  /** atualiza metrica de uso sob o lock de escrita: sem lost-update contra outra sessao */
  async markUsed(rels: readonly string[]): Promise<void> {
    if (!rels.length) return;
    try {
      await this.locked(() => {
        this.load(true);
        for (const rel of rels) {
          const p = this.pages.find((x) => x.page.rel === rel)?.page;
          if (!p) continue;
          p.uses += 1;
          p.lastUsed = nowIso();
          writeAtomic(path.join(this.pagesDir, p.rel), renderPage(p));
        }
      });
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
      hits.push({ rel, title: p.title, type: p.type, score, snippet: snippet(p), summary: p.summary, stale, uses: p.uses });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Briefing bounded (o que o proximo agente precisa saber).
   * Com `query` (o pedido do turno), as paginas sao RANQUEADAS por relevancia em vez de
   * "as 5 ultimas": mesmo orcamento de prompt, conteudo util no lugar de ruido.
   */
  brief(limit = 10, query?: string): string {
    this.load();
    const live = this.pages.map((p) => p.page).filter((p) => !p.validTo);
    const openHandoffs = live.filter((p) => p.type === "handoff" && (p.status ?? "open") !== "claimed");
    const relevantes = query && query.trim().length > 8
      ? this.query(query, { limit: limit * 2, includeStale: true })
          .map((h) => this.pages.find((x) => x.page.rel === h.rel)?.page)
          .filter((p): p is Page => Boolean(p) && !p!.validTo)
      : [];
    const porRelevancia = (tipo: PageType, n: number): Page[] => {
      const doTipo = relevantes.filter((p) => p.type === tipo);
      if (doTipo.length) return doTipo.slice(0, n);
      return live.filter((p) => p.type === tipo).slice(-n);
    };
    const decisions = porRelevancia("decision", 5);
    const gotchas = porRelevancia("gotcha", 5);
    const procedures = porRelevancia("procedure", 4);
    const stale = live.filter((p) => isStale(p));
    const lines: string[] = [];
    lines.push(`Projeto: ${this.project} · ${live.length} paginas vivas · ${stale.length} vencidas`);
    if (openHandoffs.length) {
      lines.push("", "Handoffs abertos:");
      for (const h of openHandoffs.slice(0, limit)) {
        lines.push(`${briefLine(h)}${h.owner ? ` (dono: ${h.owner})` : ""}`);
      }
    }
    const sec = (label: string, list: Page[]) => {
      if (!list.length) return;
      lines.push("", `${label}:`);
      for (const p of list) lines.push(briefLine(p));
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

  // ------------------------------------------------- aprendizado (model-profile)

  /**
   * Registra vitoria/derrota de um modelo num tipo de tarefa. Uma pagina
   * model-profile por tipo guarda o placar; o router le isso em `verdicts()`.
   * E o "cada linha e cicatriz" do artigo virado dado: o enxame aprende com o
   * proprio resultado em vez de confiar so em benchmark publicado.
   */
  async recordOutcome(kind: string, modelId: string, ok: boolean): Promise<void> {
    await this.locked(() => {
      this.load(true);
      const rel = `model-profile/desempenho-${slugify(kind, 24)}.md`;
      const atual = this.pages.find((x) => x.page.rel === rel)?.page;
      const placar = parsePlacar(atual?.body ?? "");
      const slot = (placar[modelId] ??= { ok: 0, fail: 0, last: "" });
      if (ok) slot.ok += 1;
      else slot.fail += 1;
      slot.last = nowIso();
      const linhas = Object.entries(placar)
        .sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))
        .map(([m, v]) => `| ${m} | ${v.ok} | ${v.fail} | ${v.last.slice(0, 10)} |`);
      const body = [
        `Placar autoconsolidado de despachos do FreeHive para tarefas do tipo **${kind}**.`,
        "Atualizado pelo proprio plugin depois de cada `hive run` (sem LLM: so contagem).",
        "",
        "| modelo | ok | falhas | ultimo |",
        "|---|---|---|---|",
        ...linhas,
      ].join("\n");
      const ts = atual?.created ?? nowIso();
      const page: Page = {
        rel,
        type: "model-profile",
        title: `Desempenho dos gratuitos em ${kind}`,
        body,
        created: ts,
        validFrom: atual?.validFrom ?? ts,
        staleAfter: addDays(nowIso(), TTL_DAYS["model-profile"]),
        tags: ["model-profile", kind, "auto"],
        sources: [`free-hive:${HIVE_SOURCE}`],
        relations: {},
        uses: atual?.uses ?? 0,
        summary: `placar de ${Object.keys(placar).length} modelo(s) em ${kind}`,
      };
      const full = path.join(this.pagesDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      writeAtomic(full, renderPage(page));
      this.load(true);
    }).catch(() => undefined);
  }

  /**
   * Vereditos aprendidos (minimo de amostras para nao reagir a ruido):
   * taxa de sucesso >= 70% vira "bom", <= 35% vira "ruim".
   */
  verdicts(minSamples = 3, minRate = 0.7, maxRate = 0.35): ModelVerdict[] {
    this.load();
    const out: ModelVerdict[] = [];
    for (const { page } of this.pages) {
      if (page.type !== "model-profile" || page.validTo) continue;
      const kind = (page.tags.find((t) => t !== "model-profile" && t !== "auto") ?? "") as TaskKind;
      if (!kind) continue;
      for (const [model, v] of Object.entries(parsePlacar(page.body))) {
        const total = v.ok + v.fail;
        if (total < minSamples) continue;
        const taxa = v.ok / total;
        if (taxa >= minRate) out.push({ model, kinds: [kind], verdict: "bom" });
        else if (taxa <= maxRate) out.push({ model, kinds: [kind], verdict: "ruim" });
      }
    }
    return out;
  }

  // ---------------------------------------------------------- handoffs

  async handoffOpen(input: { title: string; body: string; tags?: string[] }): Promise<Page> {
    const { page } = await this.write({ type: "handoff", ...input }, { dedupe: false });
    return page;
  }

  /** reivindica exatamente uma vez: O_EXCL no arquivo de claim */
  async claimHandoff(needle: string, claimedBy: string): Promise<{ ok: boolean; page?: Page; reason?: string }> {
    return this.locked(() => {
      this.load(true);
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
      p.owner = frontmatterSafe(claimedBy, 120);
      p.validTo = undefined;
      writeAtomic(path.join(this.pagesDir, p.rel), renderPage(p));
      auditAppend(this.dir, { event: "handoff.claim", rel: p.rel, actor: claimedBy });
      this.load(true);
      return { ok: true, page: p };
    });
  }
}

function snippet(p: Page): string {
  const clean = p.body.replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\s+/g, " ").trim();
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

/** linha de resumo para briefing: titulo + resumo (corpo so sob demanda, progressive disclosure) */
function briefLine(p: Page): string {
  return `- [${p.rel}] ${p.title}${p.summary ? ` — ${p.summary}` : ""}`;
}

/** le a tabela do placar de uma pagina model-profile */
function parsePlacar(body: string): Record<string, { ok: number; fail: number; last: string }> {
  const out: Record<string, { ok: number; fail: number; last: string }> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([\w.\-/]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d-]+)?\s*\|\s*$/);
    if (!m) continue;
    if (m[1] === "modelo" || m[1].startsWith("---")) continue;
    out[m[1]] = { ok: Number(m[2]), fail: Number(m[3]), last: m[4] ?? "" };
  }
  return out;
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
