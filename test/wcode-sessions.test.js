"use strict";

// wcode (an OpenCode-derived coding agent with its own data root at
// <home>/.wcode/cli/db/db.sqlite) adapter tests.
//
// wcode persists the same two generations of usage its lineage does: the older
// OpenCode \`message\` table, whose \`data\` JSON carries inclusive counters, and a
// newer \`model_usage\` table that is authoritative from its first completed row
// onward but is not a backfill. The merge rule is per SESSION: a session the
// native table covers keeps only its pre-native legacy rows, while a session the
// native table never touched keeps all of them. These tests pin that rule down,
// because getting it wrong either double-counts a migrated history or silently
// drops 463M tokens of it.
//
// Two further facts the fixture encodes on purpose, both verified against a live
// install: legacy rows carry camelCase \`providerId\`/\`modelId\` (never providerID),
// and counters are INCLUSIVE — input already contains cache reads, output already
// contains reasoning — so expected totals are the SPLIT ones the usage parser
// writes into the queue.
//
// \`part\` rows and message bodies carry a PRIVATE transcript marker, and every
// output assertion re-checks that none of it reaches a row or the sidecar.

const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_e) { }

const sqliteCliProbe = typeof DatabaseSync === "function"
  ? null
  : cp.spawnSync("sqlite3", ["-version"], { windowsHide: true, encoding: "utf8" });
const sqliteTest = typeof DatabaseSync === "function" || sqliteCliProbe?.status === 0
  ? test
  : test.skip;

const {
  resolveWcodeDbPaths,
  readWcodeSessionRows,
  readWcodeDbMessages,
  parseOpencodeDbIncremental,
} = require("../src/lib/rollout");
const { scanWcodeSession } = require("../src/lib/session-analytics");

const PRIVATE = "PRIVATE TRANSCRIPT BODY";
const PRIVATE_TEXT = `${PRIVATE} — prompt, assistant text and tool payloads live here`;

// The native table starts here. A session whose legacy rows predate it keeps only
// those; a session with no native rows at all keeps everything.
const NATIVE_START_MS = Date.parse("2026-11-02T08:00:00.000Z");
const LEGACY_BEFORE_MS = Date.parse("2026-11-02T07:41:00.000Z");
const LEGACY_IN_WINDOW_MS = Date.parse("2026-11-02T08:31:00.000Z");
const LEGACY_ONLY_MS = Date.parse("2026-10-20T03:12:00.000Z");

const SESSION_A = "sess_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION_LEGACY = "sess_llllllll-3333-4333-8333-llllllllllll";

function executeSql(dbPath, sql) {
  if (typeof DatabaseSync === "function") {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  cp.execFileSync("sqlite3", [dbPath, sql]);
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function literal(value) {
  return value === null || value === undefined ? "NULL" : quote(value);
}

function numberLiteral(value) {
  return value === null || value === undefined ? "NULL" : String(Number(value));
}

function jsonLiteral(value) {
  return value === null || value === undefined ? "NULL" : quote(JSON.stringify(value));
}

// The install's own layout: <home>/.wcode/cli/db/db.sqlite. Only the columns the
// adapter may depend on exist here, so schema drift fails in this file instead of
// silently reporting zero tokens.
function wcodeDbPath(home) {
  return path.join(home, ".wcode", "cli", "db", "db.sqlite");
}

function createWcodeDb(home) {
  const dbPath = wcodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  executeSql(dbPath, [
    "CREATE TABLE session (",
    "  id TEXT PRIMARY KEY,",
    "  directory TEXT,",
    "  title TEXT,",
    "  time_created INTEGER NOT NULL,",
    "  time_updated INTEGER NOT NULL",
    ");",
    "CREATE TABLE message (",
    "  id TEXT PRIMARY KEY,",
    "  session_id TEXT NOT NULL,",
    "  time_created INTEGER NOT NULL,",
    "  time_updated INTEGER NOT NULL,",
    "  data TEXT,",
    "  sequence INTEGER",
    ");",
    "CREATE TABLE part (",
    "  id TEXT PRIMARY KEY,",
    "  message_id TEXT NOT NULL,",
    "  session_id TEXT NOT NULL,",
    "  time_created INTEGER NOT NULL,",
    "  time_updated INTEGER NOT NULL,",
    "  data TEXT,",
    "  sequence INTEGER",
    ");",
    "CREATE TABLE model_usage (",
    "  id TEXT PRIMARY KEY,",
    "  logical_request_id TEXT,",
    "  attempt_index INTEGER,",
    "  session_id TEXT NOT NULL,",
    "  provider_id TEXT,",
    "  model_id TEXT,",
    "  status TEXT,",
    "  started_at INTEGER,",
    "  input_tokens INTEGER,",
    "  output_tokens INTEGER,",
    "  reasoning_tokens INTEGER,",
    "  cache_creation_input_tokens INTEGER,",
    "  cache_read_input_tokens INTEGER",
    ");",
  ].join("\n"));
  return dbPath;
}

function insertSession(dbPath, { id, title = null, directory = null, timeCreated, timeUpdated }) {
  executeSql(dbPath, [
    "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (",
    [literal(id), literal(title), literal(directory), numberLiteral(timeCreated), numberLiteral(timeUpdated)].join(", "),
    ");",
  ].join(""));
}

// A legacy assistant message. wcode writes camelCase providerId/modelId and the
// inclusive counters, so the fixture does too; `tokens` is written verbatim so a
// test can also store an all-zero set.
function insertLegacyMessage(dbPath, { id, sessionId, timeMs, tokens }) {
  const data = {
    role: "assistant",
    providerId: "new-provider-4",
    modelId: "deepseek-v4.1-flash",
    time: { created: timeMs, completed: timeMs },
    tokens,
  };
  executeSql(dbPath, [
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (",
    [literal(id), literal(sessionId), numberLiteral(timeMs), numberLiteral(timeMs), jsonLiteral(data)].join(", "),
    ");",
  ].join(""));
}

function insertPart(dbPath, { id, messageId, sessionId, timeMs }) {
  executeSql(dbPath, [
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (",
    [literal(id), literal(messageId), literal(sessionId), numberLiteral(timeMs), numberLiteral(timeMs), jsonLiteral({ text: PRIVATE_TEXT })].join(", "),
    ");",
  ].join(""));
}

function insertNativeUsage(dbPath, { id, sessionId, startedMs, input, output, reasoning = 0, cacheRead = 0, cacheWrite = 0, status = "completed" }) {
  executeSql(dbPath, [
    "INSERT INTO model_usage (id, logical_request_id, attempt_index, session_id, provider_id, model_id, status, started_at, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (",
    [
      literal(id),
      literal(id + ":req"),
      "0",
      literal(sessionId),
      literal("new-provider-4"),
      literal("deepseek-v4.1-flash"),
      literal(status),
      numberLiteral(startedMs),
      numberNumberLiteralSafe(input),
      numberNumberLiteralSafe(output),
      numberNumberLiteralSafe(reasoning),
      numberNumberLiteralSafe(cacheWrite),
      numberNumberLiteralSafe(cacheRead),
    ].join(", "),
    ");",
  ].join(""));
}

function numberNumberLiteralSafe(value) {
  return numberLiteral(value);
}

function withHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-wcode-"));
  const home = path.join(tmp, "home");
  try {
    return fn({ tmp, home });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

sqliteTest("resolveWcodeDbPaths reads <home>/.wcode and honours WCODE_HOME", () => {
  withHome(({ tmp, home }) => {
    const dbPath = createWcodeDb(home);
    assert.deepEqual(resolveWcodeDbPaths({ USERPROFILE: home, HOME: home }, { platform: "win32" }), [
      path.resolve(dbPath),
    ]);
    // An override without a database pins the install: no APPDATA fallback, and
    // never a ZCode database standing in for it.
    assert.deepEqual(
      resolveWcodeDbPaths(
        { USERPROFILE: home, HOME: home, WCODE_HOME: path.join(tmp, "missing"), APPDATA: home },
        { platform: "win32" },
      ),
      [],
    );
  });
});

sqliteTest("keeps a legacy-only session whole and drops the migrated duplicates", () => {
  withHome(({ home }) => {
    const dbPath = createWcodeDb(home);
    insertSession(dbPath, { id: SESSION_A, title: "Migrated", directory: "C:/work/migrated", timeCreated: LEGACY_BEFORE_MS, timeUpdated: LEGACY_IN_WINDOW_MS });
    insertSession(dbPath, { id: SESSION_LEGACY, title: "Legacy only", directory: "C:/work/legacy", timeCreated: LEGACY_ONLY_MS, timeUpdated: LEGACY_ONLY_MS });

    // Session A straddles the migration: one legacy row before the native table
    // starts (keep) and one inside its window (a duplicate of a native row, drop).
    insertLegacyMessage(dbPath, { id: "m_before", sessionId: SESSION_A, timeMs: LEGACY_BEFORE_MS, tokens: { input: 1000, output: 100, cache: { read: 200, write: 0 }, reasoning: 50 } });
    insertLegacyMessage(dbPath, { id: "m_dup", sessionId: SESSION_A, timeMs: LEGACY_IN_WINDOW_MS, tokens: { input: 4000, output: 400, cache: { read: 0, write: 0 }, reasoning: 0 } });
    insertNativeUsage(dbPath, { id: "mu_1", sessionId: SESSION_A, startedMs: NATIVE_START_MS, input: 4000, output: 400 });
    // A session the native table never covered keeps its whole history.
    insertLegacyMessage(dbPath, { id: "m_legacy", sessionId: SESSION_LEGACY, timeMs: LEGACY_ONLY_MS, tokens: { input: 700, output: 70, cache: { read: 0, write: 0 }, reasoning: 0 } });

    const messages = readWcodeDbMessages(dbPath);
    const ids = messages.map((m) => m.id).sort();
    assert.deepEqual(ids, ["m_before", "m_legacy", "mu_1"]);
    assert.equal(messages.some((m) => m.id === "m_dup"), false);
  });
});

sqliteTest("splits the inclusive counters and keeps the provider gate wide open for wcode's own models", () => {
  withHome(({ home }) => {
    const dbPath = createWcodeDb(home);
    insertSession(dbPath, { id: SESSION_A, directory: "C:/work/a", timeCreated: NATIVE_START_MS, timeUpdated: NATIVE_START_MS });
    insertNativeUsage(dbPath, { id: "mu_1", sessionId: SESSION_A, startedMs: NATIVE_START_MS, input: 1000, output: 100, reasoning: 50, cacheRead: 200 });
    const [message] = readWcodeDbMessages(dbPath);
    assert.ok(message, "the native row must survive the camelCase/provider gate");
    // input 1000 already contains the 200 cache reads, output 100 already contains
    // the 50 reasoning tokens.
    assert.deepEqual(message.data.tokens, {
      input: 800,
      output: 50,
      reasoning: 50,
      cache: { read: 200, write: 0 },
    });
    assert.equal(message.data.modelID, "deepseek-v4.1-flash");
  });
});

sqliteTest("drops turns the direct Claude/Codex/Gemini CLIs already count", () => {
  withHome(({ home }) => {
    const dbPath = createWcodeDb(home);
    insertSession(dbPath, { id: SESSION_A, directory: "C:/work/a", timeCreated: NATIVE_START_MS, timeUpdated: NATIVE_START_MS });
    for (const [index, provider] of ["anthropic", "openai", "google", "new-provider-4"].entries()) {
      executeSql(dbPath, [
        "INSERT INTO model_usage (id, session_id, provider_id, model_id, status, started_at, input_tokens, output_tokens) VALUES (",
        [literal("mu_" + index), literal(SESSION_A), literal(provider), literal("some-model"), literal("completed"), numberLiteral(NATIVE_START_MS + index), "10", "1"].join(", "),
        ");",
      ].join(""));
    }
    const providers = readWcodeDbMessages(dbPath).map((m) => m.data.providerID);
    assert.deepEqual(providers, ["new-provider-4"]);
  });
});

sqliteTest("scans a wcode session without leaking the transcript", async () => {
  const { home } = { home: fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-wcode-scan-")) };
  try {
    const dbPath = createWcodeDb(home);
    insertSession(dbPath, { id: SESSION_A, title: "Scan me", directory: "C:/work/scan", timeCreated: NATIVE_START_MS, timeUpdated: NATIVE_START_MS + 60_000 });
    insertNativeUsage(dbPath, { id: "mu_1", sessionId: SESSION_A, startedMs: NATIVE_START_MS, input: 1000, output: 100, reasoning: 50, cacheRead: 200 });
    insertPart(dbPath, { id: "p1", messageId: "mu_1", sessionId: SESSION_A, timeMs: NATIVE_START_MS });

    const sessions = await readWcodeSessionRows(dbPath);
    assert.equal(sessions.length, 1);
    const messages = readWcodeDbMessages(dbPath);
    const record = scanWcodeSession({ dbPath, session: sessions[0], sessionId: SESSION_A, messages });

    assert.equal(record.source, "wcode");
    assert.equal(record.session_id, SESSION_A);
    assert.equal(record.title, "Scan me");
    assert.equal(record.project_key, "scan");
    assert.deepEqual(record.tokens, {
      input_tokens: 800,
      cached_input_tokens: 200,
      cache_creation_input_tokens: 0,
      output_tokens: 50,
      reasoning_output_tokens: 50,
      total_tokens: 1100,
    });
    assert.equal(record.model, "deepseek-v4.1-flash");
    assert.equal(record.usage_precision, "reported");
    // The transcript lives in part.data and must never reach the row.
    assert.equal(JSON.stringify(record).includes(PRIVATE), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("the session scanner and the usage parser agree on the same database", async () => {
  const { home } = { home: fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-wcode-parity-")) };
  try {
    const dbPath = createWcodeDb(home);
    insertSession(dbPath, { id: SESSION_A, title: "Parity", directory: "C:/work/parity", timeCreated: NATIVE_START_MS, timeUpdated: NATIVE_START_MS });
    insertNativeUsage(dbPath, { id: "mu_1", sessionId: SESSION_A, startedMs: NATIVE_START_MS, input: 1000, output: 100, reasoning: 50, cacheRead: 200 });
    insertNativeUsage(dbPath, { id: "mu_2", sessionId: SESSION_A, startedMs: NATIVE_START_MS + 1800_000, input: 3000, output: 300, cacheRead: 0 });

    const sessions = await readWcodeSessionRows(dbPath);
    const messages = readWcodeDbMessages(dbPath);
    const scanned = scanWcodeSession({ dbPath, session: sessions[0], sessionId: SESSION_A, messages });

    const queueDir = path.join(home, "queue");
    fs.mkdirSync(queueDir, { recursive: true });
    const queuePath = path.join(queueDir, "queue.jsonl");
    fs.writeFileSync(queuePath, "");
    const cursors = { hourly: { buckets: {}, groupQueued: {} } };
    await parseOpencodeDbIncremental({
      dbMessages: messages,
      dbPath,
      dbCursor: null,
      cursors,
      queuePath,
      projectQueuePath: null,
      source: "wcode",
      cursorKey: "wcode",
    });

    const rows = fs.readFileSync(queuePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const sum = (key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    assert.equal(sum("input_tokens"), scanned.tokens.input_tokens);
    assert.equal(sum("cached_input_tokens"), scanned.tokens.cached_input_tokens);
    assert.equal(sum("output_tokens"), scanned.tokens.output_tokens);
    assert.equal(sum("reasoning_output_tokens"), scanned.tokens.reasoning_output_tokens);
    assert.equal(sum("total_tokens"), scanned.tokens.total_tokens);
    assert.equal(rows.every((row) => row.source === "wcode"), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
