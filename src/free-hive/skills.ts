/**
 * free-hive / skills.ts
 *
 * Skills locais com PROGRESSIVE DISCLOSURE (o desenho do artigo do akitaonrails):
 * no system prompt entra so `nome: descricao (quando usar)`; o corpo do SKILL.md
 * so carrega quando o agente decide invocar (`hive action="skill"`).
 *
 * Regras que vieram do artigo e estao codificadas aqui:
 *  1. Skill e diretorio com SKILL.md (frontmatter + corpo) e, opcionalmente, scripts/.
 *  2. Metadado primeiro, corpo sob demanda — instalar skill nao pode inflar o prompt.
 *  3. "Skill encostada e divida": lint cobra when_to_use, tamanho e uso.
 *  4. Skill de terceiro e prompt com as suas permissoes: source externo exige pin
 *     (commit/sha) e a skill e marcada como NAO-REVISADA ate alguem confirmar.
 *  5. Quando o padrao muda com o tempo (CI, release, empacotamento), skill e pior que
 *     apontar para o exemplo vivo do repo — isso e a acao `reference`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hasSecret } from "./security.ts";

export interface Skill {
  name: string;
  description: string;
  whenToUse: string;
  version?: string;
  /** origem externa (URL/repo); exige pin para nao virar "skill de terceiro as cegas" */
  source?: string;
  pin?: string;
  dir: string;
  body: string;
  scripts: string[];
  lines: number;
  /** onde mora: repo (versionado com o projeto), global, do projeto ou builtin (vendorizada no plugin) */
  scope: "repo" | "global" | "project" | "builtin";
}

const SKILL_FILE = "SKILL.md";
const MAX_BODY = 120_000;
/** acima disto a skill e grande demais para caber confortavelmente num turno */
const LINE_BUDGET = 150;
/** skill sem uso por este tanto vira divida declarada */
const STALE_DAYS = 90;

function frontmatter(raw: string): { head: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { head: {}, body: raw };
  const head: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    head[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { head, body: m[2] ?? "" };
}

function listScripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || out.length > 40) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name !== SKILL_FILE) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

function readSkillDir(dir: string, scope: Skill["scope"]): Skill | undefined {
  const file = path.join(dir, SKILL_FILE);
  let raw: string;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BODY) return undefined;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const { head, body } = frontmatter(raw);
  const name = (head.name || path.basename(dir)).trim();
  const description = (head.description || primeiraFrase(body)).trim();
  // skill builtin (vendorizada) nao tem when_to_use escrito a mao: a description ja
  // diz quando usar, e ela e nossa — nao vira divida de lint.
  const whenToUse = (head.when_to_use || head.when || (scope === "builtin" ? description : "")).trim();
  return {
    name,
    description: description.slice(0, 200),
    whenToUse,
    version: head.version || undefined,
    source: head.source || undefined,
    pin: head.pin || head.commit || head.sha || undefined,
    dir,
    body: body.trim(),
    scripts: listScripts(dir),
    lines: body.trim().split(/\r?\n/).length,
    scope,
  };
}

function primeiraFrase(body: string): string {
  const linha = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  return (linha ?? "").slice(0, 160);
}

/**
 * Raiz das skills vendorizadas no proprio plugin (skills/ui).
 * Resolvida a partir do modulo para funcionar em qualquer cwd.
 */
export function builtinSkillsDir(): string {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "skills", "ui");
  } catch {
    return path.join(process.cwd(), "skills", "ui");
  }
}

/**
 * Le o corpo de uma skill builtin pelo nome da pasta. Nome e validado para nao
 * virar path traversal (o nome vem de deteccao automatica de intencao).
 */
export function readBuiltinSkill(name: string): { name: string; dir: string; body: string; lines: number } | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;
  const dir = path.join(builtinSkillsDir(), name);
  const file = path.join(dir, SKILL_FILE);
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > MAX_BODY) return undefined;
    const { body } = frontmatter(raw);
    const text = body.trim();
    if (!text) return undefined;
    return { name, dir, body: text, lines: text.split(/\r?\n/).length };
  } catch {
    return undefined;
  }
}

export interface SkillRoots {
  /** raiz da memoria (~/.deepai-code/free-hive) — guarda skills globais e do projeto */
  memoryRoot: string;
  project: string;
  cwd: string;
}

export function skillDirs(roots: SkillRoots): Array<{ dir: string; scope: Skill["scope"] }> {
  return [
    { dir: path.join(roots.cwd, ".free-hive", "skills"), scope: "repo" },
    { dir: path.join(roots.memoryRoot, "skills", "_global"), scope: "global" },
    { dir: path.join(roots.memoryRoot, "skills", roots.project), scope: "project" },
    { dir: builtinSkillsDir(), scope: "builtin" },
  ];
}

/** descobre skills em todas as raizes; repo vence global vence projeto (ordem de precedencia) */
export function discoverSkills(roots: SkillRoots): Skill[] {
  const byName = new Map<string, Skill>();
  for (const { dir, scope } of skillDirs(roots)) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skill = readSkillDir(path.join(dir, e.name), scope);
      if (!skill) continue;
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** linha de indice para o prompt do sistema: metadado so, corpo nunca */
export function skillIndex(skills: readonly Skill[], max = 14): string {
  if (!skills.length) return "";
  const linhas = skills.slice(0, max).map((s) => {
    const quando = s.whenToUse ? ` — usar quando: ${s.whenToUse.slice(0, 110)}` : "";
    const scripts = s.scripts.length ? ` [${s.scripts.length} arquivo(s) em scripts/]` : "";
    return `- ${s.name}: ${s.description.slice(0, 120)}${quando}${scripts}`;
  });
  if (skills.length > max) linhas.push(`- (+${skills.length - max} skill(s): use action="skill" com o nome)`);
  return linhas.join("\n");
}

export interface SkillUse {
  count: number;
  last: string;
}

function usagePath(roots: SkillRoots): string {
  return path.join(roots.memoryRoot, "skills", "_usage.json");
}

export function readUsage(roots: SkillRoots): Record<string, SkillUse> {
  try {
    return JSON.parse(fs.readFileSync(usagePath(roots), "utf8")) as Record<string, SkillUse>;
  } catch {
    return {};
  }
}

/** marca uso (dado de retencao: skill sem uso vira divida no lint) */
export function recordSkillUse(roots: SkillRoots, name: string): void {
  try {
    const uso = readUsage(roots);
    const atual = uso[name] ?? { count: 0, last: "" };
    uso[name] = { count: atual.count + 1, last: new Date().toISOString() };
    const file = usagePath(roots);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(uso, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* metrica nao pode quebrar a leitura da skill */ }
}

export function findSkill(skills: readonly Skill[], needle: string): Skill | undefined {
  const n = needle.trim().toLowerCase();
  if (!n) return undefined;
  return (
    skills.find((s) => s.name.toLowerCase() === n) ??
    skills.find((s) => path.basename(s.dir).toLowerCase() === n) ??
    skills.find((s) => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()))
  );
}

export interface SkillLintFinding {
  skill: string;
  severity: "alta" | "media" | "baixa";
  finding: string;
}

/** lint sem LLM: "skill encostada e divida" virando checagem mecanica */
export function lintSkills(
  skills: readonly Skill[],
  usage: Record<string, SkillUse>,
  now = new Date(),
): SkillLintFinding[] {
  const out: SkillLintFinding[] = [];
  for (const s of skills) {
    if (!s.whenToUse) {
      out.push({ skill: s.name, severity: "alta", finding: "sem when_to_use: o agente nao sabe quando invocar (progressive disclosure depende disso)" });
    }
    if (!s.description) {
      out.push({ skill: s.name, severity: "alta", finding: "sem description: nao aparece util na listagem e nunca e escolhida" });
    }
    if (s.lines > LINE_BUDGET && s.scope !== "builtin") {
      out.push({ skill: s.name, severity: "media", finding: `corpo com ${s.lines} linhas (orcamento ${LINE_BUDGET}): quebre em procedimento + scripts/` });
    }
    if (s.source && !s.pin) {
      out.push({ skill: s.name, severity: "alta", finding: "source externo sem pin (commit/sha): skill de terceiro nunca revisada, roda com as suas permissoes" });
    }
    if (hasSecret(s.body)) {
      out.push({ skill: s.name, severity: "alta", finding: "segredo literal no corpo: troque por variavel de ambiente / pedido ao usuario" });
    }
    if (!s.scripts.length && s.lines > 80 && s.scope !== "builtin") {
      out.push({ skill: s.name, severity: "baixa", finding: "procedimento longo sem scripts/: o modelo recria o mesmo codigo toda vez" });
    }
    const u = usage[s.name];
    const last = u?.last ? new Date(u.last) : undefined;
    const dias = last ? (now.getTime() - last.getTime()) / 86_400_000 : Number.POSITIVE_INFINITY;
    // builtin: nao e divida por falta de uso — e contexto injetado automaticamente
    if (s.scope !== "builtin" && dias > STALE_DAYS) {
      out.push({
        skill: s.name,
        severity: "baixa",
        finding: last
          ? `sem uso ha ${Math.round(dias)} dias (ultimo ${last.toISOString().slice(0, 10)}): revise ou apague`
          : "nunca usada: revise ou apague (skill encostada e divida)",
      });
    }
  }
  return out;
}

export function ensureSkillRoots(roots: SkillRoots): void {
  for (const { dir } of skillDirs(roots)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* opcional */ }
  }
  try {
    const file = path.join(roots.memoryRoot, "skills", "_global", "README.md");
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [
        "# Skills do FreeHive",
        "",
        "Cada subpasta com SKILL.md e uma skill (uma skill por subpasta). Exemplo minimo:",
        "",
        "```md",
        "---",
        "name: pr-audit",
        "description: audita PR antes do merge",
        "when_to_use: quando o usuario pedir revisao/auditoria de PR ou patch",
        "version: 0.1.0",
        "---",
        "1. Inventarie os hunks. 2. Procure bit executavel, symlink, caractere bidi...",
        "```",
        "",
        "Regras: metadado e curto (entra no prompt); corpo so carrega quando invocado.",
        "Skill com `source:` externo exige `pin:` (commit/sha) — skill de terceiro roda com as suas permissoes.",
        "Para procedimento que muda com o tempo (CI, release), prefira `hive action=\"reference\"`: apontar o exemplo vivo do repo.",
        "",
      ].join("\n"));
    }
  } catch { /* opcional */ }
}

// ------------------------------------------------------------- reference

export interface ReferenceHit {
  path: string;
  lines: number;
  bytes: number;
  /** o que casou: nome do arquivo ou conteudo */
  why: string;
}

const REF_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "venv",
  "__pycache__", ".next", ".cache", "coverage", "bin", "obj", ".idea", ".vscode",
]);

const REF_TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sh|ps1|yml|yaml|json|toml|md|sql|tf|dockerfile|cfg|ini)$/i;

/**
 * "Aponte para o exemplo vivo": acha no repo o arquivo que ja faz o que o usuario quer,
 * para o agente ler o padrao real em vez de seguir uma skill que envelheceu.
 */
export function findReferences(
  cwd: string,
  needle: string,
  opts: { limit?: number; maxFiles?: number } = {},
): ReferenceHit[] {
  const termos = (needle.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? []).slice(0, 6);
  if (!termos.length) return [];
  const limit = opts.limit ?? 6;
  const maxFiles = opts.maxFiles ?? 4000;
  const hits: Array<ReferenceHit & { score: number }> = [];
  let visited = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 6 || visited > maxFiles || hits.length >= limit * 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (visited > maxFiles || hits.length >= limit * 4) return;
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (REF_SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      visited++;
      const base = e.name.toLowerCase();
      const nomeCasado = termos.filter((t) => base.includes(t)).length;
      let contentMatch = false;
      let lines = 0;
      let bytes = 0;
      if (REF_TEXT_EXT.test(base) || base === "dockerfile") {
        try {
          const st = fs.statSync(full);
          bytes = st.size;
          if (bytes <= 400_000) {
            const txt = fs.readFileSync(full, "utf8");
            lines = txt.split(/\r?\n/).length;
            const low = txt.toLowerCase();
            contentMatch = termos.filter((t) => low.includes(t)).length >= Math.min(2, termos.length);
          }
        } catch { continue; }
      }
      const score = nomeCasado * 3 + (contentMatch ? 2 : 0);
      if (score <= 0) continue;
      hits.push({
        path: path.relative(cwd, full).replace(/\\/g, "/"),
        lines,
        bytes,
        why: [nomeCasado ? `nome casa ${nomeCasado} termo(s)` : "", contentMatch ? "conteudo casa" : ""].filter(Boolean).join(" + "),
        score: score * 1000 + Math.min(lines, 999),
      });
    }
  };
  walk(cwd, 0);
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}

export function formatSkill(s: Skill): string {
  const meta = [
    `nome: ${s.name}`,
    `escopo: ${s.scope} (${s.dir})`,
    s.version ? `versao: ${s.version}` : "",
    s.source ? `origem: ${s.source}${s.pin ? ` @ ${s.pin}` : " (SEM PIN — trate como nao revisada)"}` : "",
    `linhas: ${s.lines}`,
    s.scripts.length ? `scripts:\n${s.scripts.map((x) => `- ${path.relative(s.dir, x).replace(/\\/g, "/")}`).join("\n")}` : "scripts: (nenhum)",
  ].filter(Boolean);
  return [`# skill ${s.name}`, meta.join("\n"), "", "## Procedimento", s.body].join("\n");
}
