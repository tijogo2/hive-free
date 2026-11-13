/**
 * free-hive / budget.ts
 *
 * Governador de cota. O enxame pode usar todos os modelos (gratuitos e pagos em
 * THEO), mas nunca pode consumir a ULTIMA fatia da cota diaria: se ele gastar
 * tudo, o usuario fica 24h sem os providers. Regras:
 *
 *  - cada lane tem rpm, rpd e (quando aplicavel) theos/dia;
 *  - janela deslizante de 1 minuto e bucket diario UTC persistido em disco;
 *  - reserva ANTES do dispatch e settlement depois, com devolucao quando o
 *    dispatch nem chegou no provider (gate de politica do app);
 *  - margem de seguranca: o enxame so usa `1 - safetyFraction` da cota;
 *  - ejecao por modelo: falha de auth/modelo morto tira o modelo por 30 min,
 *    throttle por 60s, falha transitoria 2x em 10 min por 5 min;
 *  - tudo fail-open: arquivo corrompido reseta, erro de IO nao derruba o turno.
 *
 * Numeros de referencia (capturados em 2026-11-13, ver README):
 *  - NVIDIA NIM: 40 rpm e 10.000 req/dia por conta (build.nvidia.com/faq);
 *  - DeepAI: 200 theos/dia no Free e 400/dia no Pro (deepai.org/pricing),
 *    sem rate limit de requisicao publicado;
 *  - OpenCode Zen: so LongCat 2.5 Free tem 100 req/dia publicado;
 *  - app: no maximo 2 subagentes simultaneos por provider.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type LaneId = "deepai-free" | "deepai-theo" | "nvidia" | "zen";
export type Provider = "deepai" | "opencode";
export type Tier = "free" | "paid";

export interface LaneLimit {
  /** requisicoes por minuto efetivas (conta, nao por modelo) */
  rpm: number;
  /** requisicoes por dia (UTC) efetivas */
  rpd: number;
  /** theos por dia; undefined quando a lane nao gasta theos */
  theosPerDay?: number;
  note: string;
  source: string;
}

export const LANES: Readonly<Record<LaneId, LaneLimit>> = {
  "deepai-free": {
    rpm: 20,
    rpd: 400,
    note: "sem limite publicado; o app aceita 2 subagentes simultaneos",
    source: "medido nesta sessao (deepai.org/docs nao cita rate limit)",
  },
  "deepai-theo": {
    rpm: 10,
    rpd: 200,
    theosPerDay: 200,
    note: "200 theos/dia no Free, 400/dia no Pro (200 extras)",
    source: "deepai.org/pricing",
  },
  nvidia: {
    rpm: 40,
    rpd: 10_000,
    note: "40 rpm e 10.000 req/dia por conta, divididos por todos os modelos nvidia/*",
    source: "build.nvidia.com/faq",
  },
  zen: {
    rpm: 20,
    rpd: 300,
    note: "so LongCat 2.5 Free publica 100/dia; os demais nao publicam numero",
    source: "opencode.ai/docs/console/models",
  },
};

/** overrides por modelo (id do catalogo), ex.: LongCat tem 100/dia proprio */
export const MODEL_LIMITS: Readonly<Record<string, Partial<LaneLimit>>> = {
  "longcat-2.5-free": { rpd: 100, note: "100 req/dia publicado pela OpenCode" },
};

/** limite de concorrencia do app por provider (medido: 2 subagentes) */
export const PROVIDER_CONCURRENCY: Readonly<Record<Provider, number>> = {
  deepai: 2,
  opencode: 2,
};

export const DEFAULT_SAFETY_FRACTION = 0.25;
export const DEFAULT_MAX_THEOS_PER_REQUEST = 10;

export interface BudgetConfig {
  /** fatia da cota que o enxame NAO pode tocar (0..0.9) */
  safetyFraction: number;
  /** theos/dia disponiveis na conta (200 Free, 400 Pro) */
  theosDailyAllowance: number;
  /** teto de theos para um unico request automatico */
  maxTheosPerRequest: number;
}

const DEFAULT_CONFIG: BudgetConfig = {
  safetyFraction: DEFAULT_SAFETY_FRACTION,
  theosDailyAllowance: LANES["deepai-theo"].theosPerDay ?? 200,
  maxTheosPerRequest: DEFAULT_MAX_THEOS_PER_REQUEST,
};

let config: BudgetConfig = { ...DEFAULT_CONFIG };

export function configureBudget(overrides: Partial<BudgetConfig>): BudgetConfig {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  config = {
    safetyFraction: Number.isFinite(overrides.safetyFraction as number)
      ? clamp(overrides.safetyFraction as number, 0, 0.9)
      : config.safetyFraction,
    theosDailyAllowance: Number.isFinite(overrides.theosDailyAllowance as number)
      ? Math.max(1, Math.floor(overrides.theosDailyAllowance as number))
      : config.theosDailyAllowance,
    maxTheosPerRequest: Number.isFinite(overrides.maxTheosPerRequest as number)
      ? Math.max(0, Math.floor(overrides.maxTheosPerRequest as number))
      : config.maxTheosPerRequest,
  };
  return config;
}

export function budgetConfig(): BudgetConfig {
  return { ...config };
}

// ------------------------------------------------------------------ estado

interface Bucket {
  /** dia UTC (YYYY-MM-DD) a que os contadores pertencem */
  day: string;
  dayCount: number;
  theos: number;
  /** timestamps (ms) dos requests no ultimo minuto; podado a cada uso */
  minute: number[];
  /** contagem por modelo no dia, para overrides de rpd */
  models: Record<string, number>;
}

interface ModelHealth {
  strikes: number;
  lastFailureAt: number;
  cooldownUntil: number;
  lastError?: string;
}

interface BudgetFile {
  version: 1;
  lanes: Record<string, Bucket>;
  models: Record<string, ModelHealth>;
  updatedAt: string;
}

const state: { file?: BudgetFile; path?: string } = {};

function rootDir(): string {
  return process.env.HIVE_HOME || path.join(os.homedir(), ".deepai-code", "free-hive");
}

function statePath(): string {
  return state.path ?? path.join(rootDir(), "budget.json");
}

/** para testes: usa outro arquivo */
export function useBudgetFile(file: string): void {
  state.path = file;
  state.file = undefined;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function load(): BudgetFile {
  if (state.file) return state.file;
  let file: BudgetFile = { version: 1, lanes: {}, models: {}, updatedAt: new Date().toISOString() };
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), "utf8")) as BudgetFile;
    if (raw && raw.version === 1 && raw.lanes && raw.models) file = raw;
  } catch {
    /* ausente ou corrompido: comeca limpo */
  }
  state.file = file;
  return file;
}

function save(): void {
  const file = load();
  file.updatedAt = new Date().toISOString();
  try {
    const target = statePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    /* IO nao pode derrubar o turno */
  }
}

function bucket(lane: LaneId, now: number): Bucket {
  const file = load();
  const day = utcDay(now);
  const existing = file.lanes[lane];
  if (!existing || existing.day !== day) {
    const fresh: Bucket = { day, dayCount: 0, theos: 0, minute: [], models: {} };
    file.lanes[lane] = fresh;
    return fresh;
  }
  return existing;
}

function limitFor(lane: LaneId, modelId: string): LaneLimit {
  const base = LANES[lane];
  const override = MODEL_LIMITS[modelId] ?? {};
  const theosPerDay =
    lane === "deepai-theo" ? config.theosDailyAllowance : base.theosPerDay;
  return { ...base, ...override, theosPerDay };
}

/** poda a janela de minuto e devolve quantos requests ainda cabem agora */
function minuteRoom(lane: LaneId, now: number, limit: LaneLimit): number {
  const b = bucket(lane, now);
  const cutoff = now - 60_000;
  b.minute = b.minute.filter((t) => t > cutoff);
  // guarda 1 slot de folga para o usuario nao competir com o enxame
  const hard = Math.max(1, limit.rpm - Math.max(1, Math.ceil(limit.rpm * 0.1)));
  return hard - b.minute.length;
}

export type FailureClass =
  | "throttled"
  | "timeout"
  | "auth"
  | "quota"
  | "model_not_found"
  | "unsupported"
  | "transport"
  | "policy"
  | "internal";

/** Classifica a mensagem de erro do provider (mesma taxonomia do gateway do Experiential). */
export function classifyFailure(text: string): FailureClass {
  const t = (text ?? "").toLowerCase();
  if (/\b429\b|rate.?limit|too many requests|throttl/.test(t)) return "throttled";
  if (/invalid bearer|unauthorized|\b401\b|\b403\b|authentication|api key/.test(t)) return "auth";
  if (/insufficient balance|insufficient_quota|\b402\b|credit|quota/.test(t)) return "quota";
  if (/end of life|no longer available|not found|\b404\b|model.*(missing|unknown)/.test(t)) return "model_not_found";
  if (/tool choice requires|unsupported|not supported|invalid_request/.test(t)) return "unsupported";
  if (/timeout|timed out|timedout|econnreset|etimedout|socket hang up|aborted/.test(t)) return "timeout";
  if (/econnrefused|enotfound|eai_again|fetch failed|network|dns/.test(t)) return "transport";
  if (/confirmed free model|premier|billing|payment|requires .*pro|upgrade|subscription/.test(t)) return "policy";
  return "internal";
}

/** Segundos de espera sugeridos por um Retry-After, quando o texto traz. */
export function retryAfterSeconds(text: string): number | undefined {
  const m = (text ?? "").match(/retry[- ]after[^0-9]{0,4}(\d{1,5})/i);
  if (m) return Math.min(3600, Number(m[1]));
  return undefined;
}

// ---------------------------------------------------------------- reserva

export interface Reservation {
  model: string;
  lane: LaneId;
  provider: Provider;
  theos: number;
  startedAt: number;
}

export interface Denial {
  ok: false;
  reason: string;
  lane: LaneId;
  retryAfterSeconds?: number;
}

export type ReserveResult = { ok: true; reservation: Reservation } | Denial;

export interface ReserveInput {
  model: string;
  lane: LaneId;
  provider: Provider;
  theos: number;
  now?: number;
}

/**
 * Reserva um request. Nao toca em disco em caso de negacao.
 * A reserva ja conta no minuto e no dia: se o dispatch falhar, `settle` decide
 * se devolve (falha de politica/pre-dispatch) ou mantem (o provider recebeu).
 */
export function reserve(input: ReserveInput): ReserveResult {
  const now = input.now ?? Date.now();
  const limit = limitFor(input.lane, input.model);
  if (input.theos > config.maxTheosPerRequest) {
    return {
      ok: false,
      lane: input.lane,
      reason: `modelo custa ${input.theos} theos/request, acima do teto ${config.maxTheosPerRequest}`,
    };
  }
  const health = modelHealth(input.model);
  if (health.cooldownUntil > now) {
    return {
      ok: false,
      lane: input.lane,
      reason: `modelo em cooldown (${Math.ceil((health.cooldownUntil - now) / 1000)}s)${health.lastError ? `: ${health.lastError}` : ""}`,
      retryAfterSeconds: Math.ceil((health.cooldownUntil - now) / 1000),
    };
  }
  if (minuteRoom(input.lane, now, limit) <= 0) {
    return {
      ok: false,
      lane: input.lane,
      reason: `lane ${input.lane} no limite de ${limit.rpm}/min`,
      retryAfterSeconds: 60,
    };
  }
  const b = bucket(input.lane, now);
  const usableRpd = Math.max(1, Math.floor(limit.rpd * (1 - config.safetyFraction)));
  const usableModels = Math.max(1, Math.floor(limit.rpd * (1 - config.safetyFraction)));
  const modelCount = b.models[input.model] ?? 0;
  if (b.dayCount >= usableRpd) {
    return {
      ok: false,
      lane: input.lane,
      reason: `lane ${input.lane} na cota diaria reservada (${b.dayCount}/${usableRpd} de ${limit.rpd})`,
      retryAfterSeconds: secondsToNextUtcDay(now),
    };
  }
  if (modelCount >= usableModels) {
    return {
      ok: false,
      lane: input.lane,
      reason: `modelo ${input.model} na cota diaria reservada (${modelCount}/${usableModels})`,
      retryAfterSeconds: secondsToNextUtcDay(now),
    };
  }
  if (limit.theosPerDay !== undefined) {
    const usableTheos = Math.max(1, Math.floor(limit.theosPerDay * (1 - config.safetyFraction)));
    if (b.theos + input.theos > usableTheos) {
      return {
        ok: false,
        lane: input.lane,
        reason: `orcamento de theos reservado esgotado (${b.theos}/${usableTheos} de ${limit.theosPerDay})`,
        retryAfterSeconds: secondsToNextUtcDay(now),
      };
    }
  }
  b.minute.push(now);
  b.dayCount += 1;
  b.models[input.model] = modelCount + 1;
  b.theos += input.theos;
  save();
  return {
    ok: true,
    reservation: {
      model: input.model,
      lane: input.lane,
      provider: input.provider,
      theos: input.theos,
      startedAt: now,
    },
  };
}

function secondsToNextUtcDay(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function modelHealth(model: string): ModelHealth {
  const file = load();
  return (file.models[model] ??= { strikes: 0, lastFailureAt: 0, cooldownUntil: 0 });
}

/** Trilha append-only de tentativas (auditoria). Nunca derruba o turno. */
function journalAttempt(entry: Record<string, unknown>): void {
  try {
    const target = path.join(rootDir(), "attempts.jsonl");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      if (fs.statSync(target).size > 2_000_000) fs.renameSync(target, `${target}.1`);
    } catch { /* arquivo ainda nao existe */ }
    fs.appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* journal e opcional */ }
}

function setHealth(model: string, next: Partial<ModelHealth>): void {
  const file = load();
  file.models[model] = { ...modelHealth(model), ...next };
  save();
}

export interface SettleInput {
  reservation: Reservation;
  ok: boolean;
  error?: string;
  /** override da classificacao; por padrao classifica `error` */
  failure?: FailureClass;
  now?: number;
}

/**
 * Fecha a reserva. Falha de politica/pre-dispatch devolve a cota (nada foi gasto);
 * qualquer outra falha mantem o request contado, porque o provider pode ter
 * cobrado. Sucesso zera strikes e cooldown do modelo.
 */
export function settle(input: SettleInput): FailureClass | undefined {
  const now = input.now ?? Date.now();
  const failure = input.ok ? undefined : input.failure ?? classifyFailure(input.error ?? "");
  if (input.ok) {
    setHealth(input.reservation.model, { strikes: 0, cooldownUntil: 0, lastError: undefined });
    journalAttempt({
      model: input.reservation.model,
      lane: input.reservation.lane,
      provider: input.reservation.provider,
      theos: input.reservation.theos,
      ok: true,
      durationMs: Math.max(0, now - input.reservation.startedAt),
    });
    return undefined;
  }
  const b = bucket(input.reservation.lane, now);
  if (failure === "policy") {
    b.dayCount = Math.max(0, b.dayCount - 1);
    b.theos = Math.max(0, b.theos - input.reservation.theos);
    const count = b.models[input.reservation.model] ?? 0;
    if (count > 0) b.models[input.reservation.model] = count - 1;
    const idx = b.minute.lastIndexOf(input.reservation.startedAt);
    if (idx >= 0) b.minute.splice(idx, 1);
    save();
    return failure;
  }
  const health = modelHealth(input.reservation.model);
  const strikes = health.lastFailureAt && now - health.lastFailureAt < 10 * 60_000 ? health.strikes + 1 : 1;
  let cooldownMs = 0;
  if (failure === "auth" || failure === "model_not_found" || failure === "unsupported") {
    cooldownMs = 30 * 60_000;
  } else if (failure === "throttled") {
    cooldownMs = (retryAfterSeconds(input.error ?? "") ?? 60) * 1000;
  } else if (failure === "quota") {
    cooldownMs = 15 * 60_000;
  } else if (strikes >= 2) {
    cooldownMs = 5 * 60_000;
  }
  setHealth(input.reservation.model, {
    strikes,
    lastFailureAt: now,
    cooldownUntil: now + cooldownMs,
    lastError: `${failure}: ${(input.error ?? "").slice(0, 200)}`,
  });
  journalAttempt({
    model: input.reservation.model,
    lane: input.reservation.lane,
    provider: input.reservation.provider,
    theos: input.reservation.theos,
    ok: false,
    failure,
    cooldownSeconds: Math.round(cooldownMs / 1000),
    error: (input.error ?? "").slice(0, 400),
    durationMs: Math.max(0, now - input.reservation.startedAt),
  });
  return failure;
}

// ---------------------------------------------------------------- relatorio

export interface LaneReport {
  lane: LaneId;
  limit: LaneLimit;
  usedDay: number;
  usableDay: number;
  theosDay: number;
  usableTheos?: number;
  usedMinute: number;
  usableMinute: number;
  resetsInSeconds: number;
  note: string;
  source: string;
}

export interface BudgetReport {
  now: string;
  safetyFraction: number;
  theosDailyAllowance: number;
  maxTheosPerRequest: number;
  lanes: LaneReport[];
  cooldowns: Array<{ model: string; seconds: number; reason?: string }>;
}

export function report(now = Date.now()): BudgetReport {
  const lanes = (Object.keys(LANES) as LaneId[]).map((lane) => {
    const limit = limitFor(lane, "");
    const b = bucket(lane, now);
    const cutoff = now - 60_000;
    const usedMinute = b.minute.filter((t) => t > cutoff).length;
    const usableDay = Math.max(1, Math.floor(limit.rpd * (1 - config.safetyFraction)));
    const usableMinute = Math.max(1, limit.rpm - Math.max(1, Math.ceil(limit.rpm * 0.1)));
    return {
      lane,
      limit,
      usedDay: b.dayCount,
      usableDay,
      theosDay: b.theos,
      usableTheos:
        limit.theosPerDay !== undefined
          ? Math.max(1, Math.floor(limit.theosPerDay * (1 - config.safetyFraction)))
          : undefined,
      usedMinute,
      usableMinute,
      resetsInSeconds: secondsToNextUtcDay(now),
      note: limit.note,
      source: limit.source,
    };
  });
  const file = load();
  const cooldowns = Object.entries(file.models)
    .filter(([, h]) => h.cooldownUntil > now)
    .map(([model, h]) => ({
      model,
      seconds: Math.ceil((h.cooldownUntil - now) / 1000),
      reason: h.lastError,
    }))
    .sort((a, b) => b.seconds - a.seconds);
  return {
    now: new Date(now).toISOString(),
    safetyFraction: config.safetyFraction,
    theosDailyAllowance: config.theosDailyAllowance,
    maxTheosPerRequest: config.maxTheosPerRequest,
    lanes,
    cooldowns,
  };
}

export function formatReport(r: BudgetReport): string {
  const lines: string[] = [];
  const pct = (used: number, usable: number) => `${used}/${usable} (${Math.round((used / Math.max(1, usable)) * 100)}%)`;
  lines.push(`# Orcamento do enxame — ${r.now}`);
  lines.push(
    `margem reservada para voce: ${Math.round(r.safetyFraction * 100)}% · theos/dia da conta: ${r.theosDailyAllowance} · teto por request: ${r.maxTheosPerRequest} theos`,
  );
  lines.push("");
  for (const l of r.lanes) {
    const partes = [
      `dia ${pct(l.usedDay, l.usableDay)} de ${l.limit.rpd}`,
      `minuto ${pct(l.usedMinute, l.usableMinute)} de ${l.limit.rpm}`,
    ];
    if (l.limit.theosPerDay !== undefined) {
      partes.push(`theos ${l.theosDay}/${l.usableTheos} de ${l.limit.theosPerDay}`);
    }
    lines.push(`- ${l.lane}: ${partes.join(" · ")} · reseta em ${Math.round(l.resetsInSeconds / 3600)}h`);
    lines.push(`  ${l.note} (${l.source})`);
  }
  if (r.cooldowns.length) {
    lines.push("");
    lines.push("Modelos em cooldown:");
    for (const c of r.cooldowns) {
      lines.push(`- ${c.model}: ${Math.ceil(c.seconds / 60)} min${c.reason ? ` — ${c.reason}` : ""}`);
    }
  }
  lines.push("");
  lines.push(`Trilha de tentativas: ${path.join(rootDir(), "attempts.jsonl")}`);
  return lines.join("\n");
}

/** Zera contadores (nao mexe em cooldowns, a menos que `all`). */
export function reset(scope: "lanes" | "all" = "all"): void {
  const file = load();
  if (scope === "all") {
    file.lanes = {};
    file.models = {};
  } else {
    for (const key of Object.keys(file.lanes)) delete file.lanes[key];
  }
  save();
}

/** Quanto ainda cabe de theos hoje, respeitando a margem. */
export function theosHeadroom(now = Date.now()): number {
  const limit = limitFor("deepai-theo", "");
  const usable = Math.max(1, Math.floor((limit.theosPerDay ?? 0) * (1 - config.safetyFraction)));
  return Math.max(0, usable - bucket("deepai-theo", now).theos);
}

/** O modelo pode ser tentado agora? (cooldown apenas; a cota e checada na reserva) */
export function isCooling(model: string, now = Date.now()): boolean {
  return modelHealth(model).cooldownUntil > now;
}
