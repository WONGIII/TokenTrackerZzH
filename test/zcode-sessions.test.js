"use strict";

// ZCode (Z.ai's coding agent — an OpenCode-fork SQLite database at
// <home>/.zcode/cli/db/db.sqlite) adapter tests.
//
// The fixture mirrors the verified schema: one `session` row per session plus
// one `message` row per turn whose `data` JSON carries the assistant
// counters. ZCode persists INCLUSIVE parent counters — cache read/write are
// already inside `input`, reasoning is already inside `output` — so the
// fixture stores them that way and the expected totals are the SPLIT ones the
// usage parser writes into the queue. A passthrough would inflate the numbers
// here instead of silently in production (issue #554).
//
// `part` rows and the message bodies carry a PRIVATE transcript marker, and
// every output assertion re-checks that none of it reaches a row, the browser
// payload, or the sidecar.

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
  resolveZcodeDbPaths,
  readZcodeSessionRows,
  readZcodeDbMessages,
  parseOpencodeDbIncremental,
} = require("../src/lib/rollout");
const { scanZcodeSession, buildSessionAnalytics } = require("../src/lib/session-analytics");

// Never allowed to appear in an output row, an API payload or the sidecar.
const PRIVATE = "PRIVATE TRANSCRIPT BODY";
const PRIVATE_TEXT = `${PRIVATE} — prompt, assistant text and tool payloads live here`;

// Epoch ms for the two turns of session A. They land in different half-hour UTC
// buckets, which is why the parity check below compares the summed buckets with
// the summed sessions rather than one bucket with one session.
const TURN_1_MS = Date.parse("2026-09-21T04:23:20.286Z");
const TURN_2_MS = Date.parse("2026-09-21T04:41:02.500Z");

const SESSION_A = "sess_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION_B = "sess_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

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

// The launcher's own layout: <home>/.zcode/cli/db/db.sqlite. Only the columns the
// adapter is allowed to depend on exist here, so a schema drift (a renamed
// column, a different table) fails in this file instead of silently reporting
// zero tokens.
function zcodeDbPath(home) {
  return path.join(home, ".zcode", "cli", "db", "db.sqlite");
}

function createZcodeDb(home) {
  const dbPath = zcodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  executeSql(dbPath, [
    "CREATE TABLE session (",
    "  id TEXT PRIMARY KEY,",
    "  project_id TEXT,",
    "  workspace_id TEXT,",
    "  parent_id TEXT,",
    "  slug TEXT,",
    "  directory TEXT,",
    "  path TEXT,",
    "  title TEXT,",
    "  version TEXT,",
    "  share_url TEXT,",
    "  summary_additions INTEGER,",
    "  summary_deletions INTEGER,",
    "  summary_files INTEGER,",
    "  summary_diffs TEXT,",
    "  revert TEXT,",
    "  permission TEXT,",
    "  time_created INTEGER NOT NULL,",
    "  time_updated INTEGER NOT NULL,",
    "  time_compacting INTEGER,",
    "  time_archived INTEGER,",
    "  task_type TEXT,",
    "  title_source TEXT,",
    "  title_message_id TEXT,",
    "  time_title_updated INTEGER,",
    "  trace_id TEXT",
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

// An assistant message. `tokens` is written verbatim so a test can store
// ZCode's inclusive counters, an all-zero set, or nothing at all.
// `providerID` is the discriminator isZcodeNativeMessage() keys off (it drops
// the bundled anthropic/openai/google sub-agents whose turns the standalone
// Claude/Codex/Gemini parsers already count). Modern ZCode also writes a
// camelCase `providerId` in message.data, which that discriminator does not
// read — see the note in the report on this adapter.
function insertAssistantMessage(dbPath, {
  id,
  sessionId,
  timeCreated,
  timeUpdated = timeCreated,
  tokens,
  data = null,
  nullData = false,
  modelId = "GLM-5.2",
  providerID = "builtin:zai-start-plan",
}) {
  const payload = nullData ? null : (data !== null ? data : {
    role: "assistant",
    time: { created: timeCreated, completed: timeUpdated },
    modelId,
    providerID,
    agent: "zcode-agent",
    cost: 0,
    tokens,
    // The transcript ZCode stores beside the counters. Never read.
    text: PRIVATE_TEXT,
  });
  executeSql(dbPath, [
    "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (",
    [literal(id), literal(sessionId), numberLiteral(timeCreated), numberLiteral(timeUpdated), jsonLiteral(payload), numberLiteral(0)].join(", "),
    ");",
  ].join(""));
  // A content part for the same message: the reader must never select `part`.
  executeSql(dbPath, [
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (",
    [literal(`${id}-part-0`), literal(id), literal(sessionId), numberLiteral(timeCreated), numberLiteral(timeUpdated), jsonLiteral({ type: "text", text: PRIVATE_TEXT }), numberLiteral(0)].join(", "),
    ");",
  ].join(""));
}

// A user turn carries no counters and must not become a session turn.
function insertUserMessage(dbPath, { id, sessionId, timeCreated }) {
  executeSql(dbPath, [
    "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (",
    [literal(id), literal(sessionId), numberLiteral(timeCreated), numberLiteral(timeCreated), jsonLiteral({ role: "user", time: { created: timeCreated }, text: PRIVATE_TEXT }), numberLiteral(0)].join(", "),
    ");",
  ].join(""));
}

// The native usage table modern ZCode writes. Only the columns
// detectZcodeNativeUsageLayout() probes and buildZcodeNativeUsageSql() selects
// exist here, so a rename fails in this file.
function createZcodeNativeUsageTable(dbPath) {
  executeSql(dbPath, [
    "CREATE TABLE model_usage (",
    "  id TEXT PRIMARY KEY,",
    "  logical_request_id TEXT,",
    "  attempt_index INTEGER,",
    "  session_id TEXT,",
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
}

// Native counters are inclusive too: cache read/write are inside input and
// reasoning is inside output (issue #554), exactly like the message-table rows.
function insertNativeUsage(dbPath, {
  id,
  sessionId,
  startedAt,
  status = "completed",
  modelId = "GLM-5.2",
  providerId = "builtin:zai-start-plan",
  inputTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  cacheRead = 0,
  cacheWrite = 0,
}) {
  executeSql(dbPath, [
    "INSERT INTO model_usage (id, logical_request_id, attempt_index, session_id, provider_id, model_id, status, started_at, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (",
    [
      literal(id), literal(id + "-logical"), numberLiteral(0), literal(sessionId),
      literal(providerId), literal(modelId), literal(status), numberLiteral(startedAt),
      numberLiteral(inputTokens), numberLiteral(outputTokens), numberLiteral(reasoningTokens),
      numberLiteral(cacheWrite), numberLiteral(cacheRead),
    ].join(", "),
    ");",
  ].join(""));
}

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-"));
}

// The two sessions every fixture test starts from. Session A carries two
// finalized turns, B one, and both carry rows that must not be counted (an
// all-zero counter set, a bodyless row, and a user turn).
function writeFixture(home) {
  const dbPath = createZcodeDb(home);
  insertSession(dbPath, {
    id: SESSION_A,
    title: "Fixture session",
    directory: "D:\\zcodeprojectxianmu\\test",
    timeCreated: TURN_1_MS - 1000,
    timeUpdated: TURN_2_MS + 1000,
  });
  insertUserMessage(dbPath, { id: "msg-a-user", sessionId: SESSION_A, timeCreated: TURN_1_MS });
  insertAssistantMessage(dbPath, {
    id: "msg-a-1",
    sessionId: SESSION_A,
    timeCreated: TURN_1_MS,
    timeUpdated: TURN_1_MS + 5000,
    tokens: { total: 1050, input: 1000, output: 50, reasoning: 10, cache: { read: 200, write: 5 } },
  });
  insertAssistantMessage(dbPath, {
    id: "msg-a-2",
    sessionId: SESSION_A,
    timeCreated: TURN_2_MS,
    tokens: { total: 520, input: 500, output: 20, cache: { read: 100, write: 0 } },
  });
  // Inserted AFTER the finalized turns so an implementation that takes the last
  // row per session cannot pass by accident.
  insertAssistantMessage(dbPath, {
    id: "msg-a-unfinalized",
    sessionId: SESSION_A,
    timeCreated: TURN_2_MS + 2000,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  // A row whose body is missing entirely. (Not a malformed JSON body: SQLite's
  // json_extract raises on one, which aborts the whole v1 read — see the reader
  // in rollout.js. ZCode always writes valid JSON, so a NULL body is the
  // realistic degradation here.)
  insertAssistantMessage(dbPath, {
    id: "msg-a-nobody",
    sessionId: SESSION_A,
    timeCreated: TURN_2_MS + 3000,
    data: null,
    nullData: true,
  });

  insertSession(dbPath, {
    id: SESSION_B,
    title: "Second fixture session",
    directory: "/home/dev/other-project",
    timeCreated: TURN_1_MS - 5000,
    timeUpdated: TURN_1_MS + 500,
  });
  insertAssistantMessage(dbPath, {
    id: "msg-b-1",
    sessionId: SESSION_B,
    timeCreated: TURN_1_MS + 250,
    modelId: "GLM-5-Turbo",
    tokens: { total: 2100, input: 2000, output: 100, reasoning: 40, cache: { read: 1500, write: 0 } },
  });
  return dbPath;
}

function latestBuckets(queuePath) {
  const buckets = new Map();
  const raw = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, "utf8") : "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    buckets.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  return buckets;
}

// Parity guard: the session browser and the usage parser read the same rows, so
// their token sums must be equal. This is the invariant the whole adapter exists
// to preserve — a session card that disagrees with the queue is worse than no
// card at all.
sqliteTest("ZCode session totals match the usage parser for the same database", async () => {
  const home = makeHome();
  const tmp = makeHome();
  try {
    const dbPath = writeFixture(home);
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = {};
    await parseOpencodeDbIncremental({
      dbMessages: readZcodeDbMessages(dbPath),
      dbPath,
      source: "zcode",
      cursorKey: "zcode",
      cursors,
      queuePath,
      projectQueuePath,
    });
    let parserTotal = 0;
    for (const row of latestBuckets(queuePath).values()) parserTotal += row.total_tokens;

    const rows = await buildSessionAnalytics({ home, force: true });
    const zcodeRows = rows.filter((row) => row.source === "zcode");
    const sessionTotal = zcodeRows.reduce((sum, row) => sum + row.total_tokens, 0);

    assert.equal(parserTotal, 3670, "same rows, same inclusive-token split");
    assert.equal(sessionTotal, parserTotal);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

sqliteTest("scanZcodeSession builds one session row per session table row", async () => {
  const home = makeHome();
  try {
    const dbPath = writeFixture(home);
    const sessions = await readZcodeSessionRows(dbPath);
    assert.equal(sessions.length, 2);

    const byId = new Map(sessions.map((session) => [session.id, session]));
    const messagesBySession = new Map();
    for (const message of readZcodeDbMessages(dbPath)) {
      const list = messagesBySession.get(message.sessionID) || [];
      list.push(message);
      messagesBySession.set(message.sessionID, list);
    }
    assert.deepEqual([...messagesBySession.keys()].sort(), [SESSION_A, SESSION_B]);

    const rowA = scanZcodeSession({
      dbPath,
      sessionId: SESSION_A,
      session: byId.get(SESSION_A),
      messages: messagesBySession.get(SESSION_A),
    });
    assert.equal(rowA.source, "zcode");
    assert.equal(rowA.session_id, SESSION_A);
    assert.equal(rowA.title, "Fixture session");
    assert.equal(rowA.model, "GLM-5.2");
    assert.equal(rowA.turns, 2, "the unfinalized, bodyless and user rows are not turns");
    assert.equal(rowA.usage_events, 2);
    // ZCode's inclusive counters, split the way the usage parser splits them:
    // input 1000-200-5 and 500-100, output 50-10 and 20.
    assert.equal(rowA.tokens.input_tokens, 1195);
    assert.equal(rowA.tokens.cached_input_tokens, 300);
    assert.equal(rowA.tokens.cache_creation_input_tokens, 5);
    assert.equal(rowA.tokens.output_tokens, 60);
    assert.equal(rowA.tokens.reasoning_output_tokens, 10);
    assert.equal(rowA.tokens.total_tokens, 1570);
    assert.equal(rowA.started_at, new Date(TURN_1_MS - 1000).toISOString());
    assert.equal(rowA.ended_at, new Date(TURN_2_MS + 1000).toISOString());
    assert.equal(rowA.project_key, "test");
    assert.equal(rowA.project_ref, "D:\\zcodeprojectxianmu\\test");
    assert.equal(rowA.model_usage.length, 1);
    assert.equal(rowA.model_usage[0].model, "GLM-5.2");
    assert.equal(rowA.model_usage[0].total_tokens, 1570);
    assert.equal(rowA.model_usage[0].usage_events, 2);
    assert.equal(rowA.usage_precision, "reported");
    assert.equal(rowA.cost_is_partial, false);
    assert.equal(rowA.provenance.content_retained, false);
    assert.doesNotMatch(JSON.stringify(rowA), /PRIVATE TRANSCRIPT BODY/);

    const rowB = scanZcodeSession({
      dbPath,
      sessionId: SESSION_B,
      session: byId.get(SESSION_B),
      messages: messagesBySession.get(SESSION_B),
    });
    assert.equal(rowB.session_id, SESSION_B);
    assert.equal(rowB.model, "GLM-5-Turbo");
    assert.equal(rowB.turns, 1);
    assert.equal(rowB.tokens.input_tokens, 500);
    assert.equal(rowB.tokens.cached_input_tokens, 1500);
    assert.equal(rowB.tokens.output_tokens, 60);
    assert.equal(rowB.tokens.reasoning_output_tokens, 40);
    assert.equal(rowB.tokens.total_tokens, 2100);
    // A session row on its own bounds the session, exactly like the AstrBot and
    // OpenBitFun scanners.
    assert.equal(rowB.started_at, new Date(TURN_1_MS - 5000).toISOString());
    assert.equal(rowB.ended_at, new Date(TURN_1_MS + 500).toISOString());
    assert.doesNotMatch(JSON.stringify(rowB), /PRIVATE TRANSCRIPT BODY/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("scanZcodeSession reports a session with no finalized turn as unavailable", async () => {
  const home = makeHome();
  try {
    const dbPath = createZcodeDb(home);
    insertSession(dbPath, {
      id: SESSION_A,
      title: "Empty",
      directory: "/home/dev/empty",
      timeCreated: TURN_1_MS,
      timeUpdated: TURN_2_MS,
    });
    insertAssistantMessage(dbPath, {
      id: "msg-empty",
      sessionId: SESSION_A,
      timeCreated: TURN_1_MS,
      tokens: { total: 0, input: 0, output: 0 },
    });
    const sessions = await readZcodeSessionRows(dbPath);
    const rows = scanZcodeSession({
      dbPath,
      sessionId: SESSION_A,
      session: sessions[0],
      messages: readZcodeDbMessages(dbPath),
    });
    assert.equal(rows.turns, 0);
    assert.equal(rows.usage_events, 0);
    assert.equal(rows.tokens.total_tokens, 0);
    assert.equal(rows.usage_precision, "unavailable");
    assert.equal(rows.started_at, new Date(TURN_1_MS).toISOString());
    assert.equal(rows.ended_at, new Date(TURN_2_MS).toISOString());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("scanZcodeSession reads the native model_usage rows modern ZCode writes", async () => {
  const home = makeHome();
  try {
    const dbPath = createZcodeDb(home);
    insertSession(dbPath, {
      id: SESSION_A,
      title: "Native fixture",
      directory: "D:\\\\zcodeprojectxianmu\\\\test",
      timeCreated: TURN_1_MS - 600000,
      timeUpdated: TURN_2_MS,
    });
    // ZCode only started writing model_usage after many installs had already
    // accumulated history in the OpenCode message tables, so a legacy row older
    // than the first native row is genuine backfill and must stay counted.
    insertAssistantMessage(dbPath, {
      id: "msg-legacy-historical",
      sessionId: SESSION_A,
      timeCreated: TURN_1_MS - 600000,
      tokens: { total: 300, input: 300, output: 0 },
    });
    createZcodeNativeUsageTable(dbPath);
    insertNativeUsage(dbPath, {
      id: "mu-1",
      sessionId: SESSION_A,
      startedAt: TURN_1_MS,
      inputTokens: 1000,
      outputTokens: 50,
      reasoningTokens: 10,
      cacheRead: 200,
      cacheWrite: 5,
    });
    insertNativeUsage(dbPath, {
      id: "mu-2",
      sessionId: SESSION_A,
      startedAt: TURN_2_MS,
      inputTokens: 500,
      outputTokens: 20,
      cacheRead: 100,
    });
    // Not countable: a cancelled request, a row with no model, and a finalized
    // row whose counters are all zero.
    insertNativeUsage(dbPath, { id: "mu-cancelled", sessionId: SESSION_A, startedAt: TURN_2_MS, status: "cancelled", inputTokens: 9999 });
    insertNativeUsage(dbPath, { id: "mu-nomodel", sessionId: SESSION_A, startedAt: TURN_2_MS, modelId: "", inputTokens: 9999 });
    insertNativeUsage(dbPath, { id: "mu-zero", sessionId: SESSION_A, startedAt: TURN_2_MS });

    const sessions = await readZcodeSessionRows(dbPath);
    const messages = readZcodeDbMessages(dbPath);
    assert.equal(messages.length, 3, "the historical legacy row plus the two countable native rows");
    const row = scanZcodeSession({
      dbPath,
      sessionId: SESSION_A,
      session: sessions[0],
      messages,
    });
    assert.equal(row.turns, 3);
    assert.equal(row.usage_events, 3);
    assert.equal(row.tokens.input_tokens, 1495);
    assert.equal(row.tokens.cached_input_tokens, 300);
    assert.equal(row.tokens.cache_creation_input_tokens, 5);
    assert.equal(row.tokens.output_tokens, 60);
    assert.equal(row.tokens.reasoning_output_tokens, 10);
    assert.equal(row.tokens.total_tokens, 1870);
    assert.equal(row.project_ref, "D:\\\\zcodeprojectxianmu\\\\test");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("buildSessionAnalytics discovers ZCode sessions from the injected home", async () => {
  const home = makeHome();
  const savedEnv = {};
  for (const key of ["TOKENTRACKER_ZCODE_HOME", "ZCODE_HOME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    writeFixture(home);
    const rows = await buildSessionAnalytics({ home, force: true });
    const zcodeRows = rows.filter((row) => row.source === "zcode");
    assert.equal(zcodeRows.length, 2, "every session of the database is browsable");
    assert.deepEqual(
      zcodeRows.map((row) => row.session_id).sort(),
      [SESSION_A, SESSION_B].sort(),
    );
    const bySession = new Map(zcodeRows.map((row) => [row.session_id, row]));
    assert.equal(bySession.get(SESSION_A).title, "Fixture session");
    assert.equal(bySession.get(SESSION_A).tokens.input_tokens, 1195);
    assert.equal(bySession.get(SESSION_B).tokens.total_tokens, 2100);

    // The sidecar is local-only, but it must still carry no transcript and no
    // part payload.
    const sidecar = fs.readFileSync(
      path.join(home, ".tokentracker", "tracker", "session.queue.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(sidecar, /PRIVATE TRANSCRIPT BODY/);

    // A rebuild with nothing changed reuses the cached rows.
    const again = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
    assert.equal(again.filter((row) => row.source === "zcode").length, 2);

    // A newly finalized turn moves the database's stat key and rebuilds that
    // session's row without dropping its sibling.
    insertAssistantMessage(path.join(home, ".zcode", "cli", "db", "db.sqlite"), {
      id: "msg-b-2",
      sessionId: SESSION_B,
      timeCreated: TURN_2_MS,
      modelId: "GLM-5-Turbo",
      tokens: { total: 300, input: 300, output: 0 },
    });
    const refreshed = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
    const refreshedById = new Map(
      refreshed.filter((row) => row.source === "zcode").map((row) => [row.session_id, row]),
    );
    assert.equal(refreshed.filter((row) => row.source === "zcode").length, 2);
    assert.equal(refreshedById.get(SESSION_B).turns, 2);
    assert.equal(refreshedById.get(SESSION_B).tokens.total_tokens, 2400);
    assert.equal(refreshedById.get(SESSION_A).tokens.total_tokens, 1570);
  } finally {
    for (const key of ["TOKENTRACKER_ZCODE_HOME", "ZCODE_HOME"]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("scanZcodeSession keeps counting a session whose session row is gone", async () => {
  const home = makeHome();
  try {
    const dbPath = createZcodeDb(home);
    insertSession(dbPath, {
      id: SESSION_A,
      title: "Still here",
      directory: "/home/dev/gone",
      timeCreated: TURN_1_MS,
      timeUpdated: TURN_1_MS,
    });
    insertAssistantMessage(dbPath, {
      id: "msg-a-1",
      sessionId: SESSION_A,
      timeCreated: TURN_1_MS,
      tokens: { total: 100, input: 100, output: 0 },
    });
    insertAssistantMessage(dbPath, {
      id: "msg-orphan-1",
      sessionId: "sess_orphan",
      timeCreated: TURN_2_MS,
      tokens: { total: 700, input: 700, output: 0 },
    });
    // The session row is deleted while its messages stay behind: those rows are
    // real billed usage, so the browser has to keep showing them.
    executeSql(dbPath, `DELETE FROM session WHERE id = '${SESSION_A}';`);

    const rows = await buildSessionAnalytics({ home, force: true });
    const zcodeRows = rows.filter((row) => row.source === "zcode");
    assert.deepEqual(zcodeRows.map((row) => row.session_id).sort(), [SESSION_A, "sess_orphan"]);
    assert.equal(zcodeRows.reduce((sum, row) => sum + row.total_tokens, 0), 800);
    assert.equal(zcodeRows.find((row) => row.session_id === "sess_orphan").title, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("ZCode resolver honors the home overrides and never widens an injected home", () => {
  const home = makeHome();
  const appData = makeHome();
  const overrideHome = makeHome();
  const savedEnv = {};
  for (const key of ["TOKENTRACKER_ZCODE_HOME", "ZCODE_HOME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    const nativeDb = zcodeDbPath(home);
    fs.mkdirSync(path.dirname(nativeDb), { recursive: true });
    fs.writeFileSync(nativeDb, "");
    const appDataDb = path.join(appData, ".zcode", "cli", "db", "db.sqlite");
    fs.mkdirSync(path.dirname(appDataDb), { recursive: true });
    fs.writeFileSync(appDataDb, "");
    const overrideDb = path.join(overrideHome, "cli", "db", "db.sqlite");
    fs.mkdirSync(path.dirname(overrideDb), { recursive: true });
    fs.writeFileSync(overrideDb, "");

    // The injected home is the whole world: APPDATA is a machine-wide constant
    // and must not drag the developer's real install into a fixture run.
    assert.deepEqual(
      resolveZcodeDbPaths({ APPDATA: appData, USERPROFILE: "C:\\nope" }, { nativeHome: home }),
      [nativeDb],
    );

    // A spelling that resolves to the same file collapses into one entry.
    assert.deepEqual(
      resolveZcodeDbPaths(
        { TOKENTRACKER_ZCODE_HOME: path.join(home, ".zcode", "cli", "..") },
        { nativeHome: path.join(appData, "elsewhere") },
      ),
      [nativeDb],
    );

    assert.deepEqual(
      resolveZcodeDbPaths({ ZCODE_HOME: overrideHome }, { nativeHome: home }),
      [overrideDb],
    );

    // An override that names an install without a database pins that install:
    // there is no fallback to another one.
    const emptyHome = makeHome();
    try {
      assert.deepEqual(
        resolveZcodeDbPaths({ ZCODE_HOME: emptyHome, APPDATA: appData }, { nativeHome: home }),
        [],
      );
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }

    // Nothing installed at all resolves to an empty list, not a phantom path.
    const bare = makeHome();
    try {
      assert.deepEqual(resolveZcodeDbPaths({}, { nativeHome: bare }), []);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    for (const key of ["TOKENTRACKER_ZCODE_HOME", "ZCODE_HOME"]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(overrideHome, { recursive: true, force: true });
  }
});
