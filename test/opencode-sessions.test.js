"use strict";

// opencode (the upstream ZCode forked from — an OpenCode SQLite database at
// <data dir>/opencode.db, i.e. ~/.local/share/opencode/opencode.db) adapter
// tests.
//
// THE structural difference from the ZCode fixture next door: opencode's
// `session` row carries the session's own token totals
// (tokens_input/output/reasoning/cache_read/cache_write), so the fixture writes
// them there and the message bodies deliberately do NOT drive the numbers. The
// `message` table is what sync reads, so the parity guard below builds both
// sides out of the same rows and requires them to agree.
//
// Only the columns this adapter is allowed to depend on exist in the fixture, so
// a schema drift (a renamed column, a different table) fails in this file instead
// of silently reporting zero tokens.
//
// `part` rows and the message bodies carry a PRIVATE transcript marker, and
// every output assertion re-checks that none of it reaches a row, the browser
// payload or the sidecar.

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
  resolveOpencodeDbPaths,
  readOpencodeSessionRows,
  readOpencodeSessionTurnCounts,
  readOpencodeDbMessages,
  parseOpencodeDbIncremental,
} = require("../src/lib/rollout");
const { scanOpencodeSession, buildSessionAnalytics } = require("../src/lib/session-analytics");

// Never allowed to appear in an output row, an API payload or the sidecar.
const PRIVATE = "PRIVATE TRANSCRIPT BODY";
const PRIVATE_TEXT = `${PRIVATE} — prompt, assistant text and tool payloads live here`;

// Epoch ms for the two turns of session A. They land in different half-hour UTC
// buckets, which is why the parity check below compares the summed buckets with
// the summed sessions rather than one bucket with one session.
const TURN_1_MS = Date.parse("2026-09-21T04:23:20.286Z");
const TURN_2_MS = Date.parse("2026-09-21T04:41:02.500Z");

const SESSION_A = "ses_aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION_B = "ses_bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SESSION_EMPTY = "ses_cccccccc-3333-4333-8333-cccccccccccc";

const MODEL_A = JSON.stringify({ id: "deepseek-v4-pro", providerID: "deepseek", variant: "default" });
const MODEL_B = JSON.stringify({ id: "mimo-v2.5-pro", providerID: "xiaomi-token-plan-sgp", variant: "default" });

// The env vars that decide where opencode lives. Cleared for the whole file so
// neither an override nor a stray XDG_DATA_HOME can splice the developer's real
// install into a fixture run.
const OPENCODE_ENV_KEYS = ["OPENCODE_HOME", "XDG_DATA_HOME"];

function withCleanEnv(fn) {
  const saved = {};
  for (const key of OPENCODE_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of OPENCODE_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

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

// The verified on-disk layout: <data dir>/opencode.db.
function opencodeDbPath(home) {
  return path.join(home, ".local", "share", "opencode", "opencode.db");
}

function createOpencodeDb(home) {
  const dbPath = opencodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  executeSql(dbPath, [
    "CREATE TABLE session (",
    "  id TEXT PRIMARY KEY,",
    "  project_id TEXT,",
    "  parent_id TEXT,",
    "  title TEXT,",
    "  directory TEXT,",
    "  model TEXT,",
    "  cost REAL,",
    "  tokens_input INTEGER,",
    "  tokens_output INTEGER,",
    "  tokens_reasoning INTEGER,",
    "  tokens_cache_read INTEGER,",
    "  tokens_cache_write INTEGER,",
    "  time_created INTEGER NOT NULL,",
    "  time_updated INTEGER NOT NULL",
    ");",
    "CREATE TABLE message (",
    "  id TEXT PRIMARY KEY,",
    "  session_id TEXT NOT NULL,",
    "  time_created INTEGER NOT NULL,",
    "  time_updated INTEGER NOT NULL,",
    "  data TEXT",
    ");",
    "CREATE TABLE part (",
    "  id TEXT PRIMARY KEY,",
    "  message_id TEXT NOT NULL,",
    "  session_id TEXT NOT NULL,",
    "  time_created INTEGER NOT NULL,",
    "  time_updated INTEGER NOT NULL,",
    "  data TEXT",
    ");",
  ].join("\n"));
  return dbPath;
}

// A session row. Every token column defaults to 0 so a test can write the exact
// counters it wants to assert on.
function insertSession(dbPath, {
  id,
  title = null,
  directory = null,
  model = null,
  timeCreated,
  timeUpdated,
  tokensInput = 0,
  tokensOutput = 0,
  tokensReasoning = 0,
  tokensCacheRead = 0,
  tokensCacheWrite = 0,
  cost = 0,
  parentId = null,
}) {
  executeSql(dbPath, [
    "INSERT INTO session (id, project_id, parent_id, title, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES (",
    [
      literal(id), literal("global"), literal(parentId), literal(title), literal(directory), literal(model),
      numberLiteral(cost), numberLiteral(tokensInput), numberLiteral(tokensOutput), numberLiteral(tokensReasoning),
      numberLiteral(tokensCacheRead), numberLiteral(tokensCacheWrite),
      numberLiteral(timeCreated), numberLiteral(timeUpdated),
    ].join(", "),
    ");",
  ].join(""));
}

// One message row plus the content part that belongs to it. `tokens` is written
// verbatim (opencode's message counters are disjoint: cache read/write are NOT
// inside `input` and reasoning is NOT inside `output`, unlike ZCode's).
function insertMessage(dbPath, {
  id,
  sessionId,
  timeCreated,
  timeUpdated = timeCreated,
  role = "assistant",
  tokens = null,
  modelId = "deepseek-v4-pro",
  providerID = "deepseek",
  data = null,
}) {
  const payload = data !== null ? data : {
    role,
    time: { created: timeCreated, completed: timeUpdated },
    modelID: modelId,
    providerID,
    path: { cwd: "/home/dev/other-project" },
    cost: 0,
    tokens,
    // The transcript opencode stores beside the counters. Never read.
    text: PRIVATE_TEXT,
  };
  executeSql(dbPath, [
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (",
    [literal(id), literal(sessionId), numberLiteral(timeCreated), numberLiteral(timeUpdated), jsonLiteral(payload)].join(", "),
    ");",
  ].join(""));
  // A content part for the same message: the reader must never select `part`.
  executeSql(dbPath, [
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (",
    [
      literal(`${id}-part-0`), literal(id), literal(sessionId),
      numberLiteral(timeCreated), numberLiteral(timeUpdated),
      jsonLiteral({ type: "text", text: PRIVATE_TEXT }),
    ].join(", "),
    ");",
  ].join(""));
}

// Session A carries two finalized turns, B one, and C a session row whose
// counters are all zero. Each session row's counters are the SUM of its
// messages' counters, which is exactly the invariant the live database holds and
// the parity guard below re-establishes from the usage parser's side.
function writeFixture(home) {
  const dbPath = createOpencodeDb(home);

  insertSession(dbPath, {
    id: SESSION_A,
    title: "Fixture session",
    directory: "D:/opencode/projectxianmu/test",
    model: MODEL_A,
    timeCreated: TURN_1_MS - 1000,
    timeUpdated: TURN_2_MS + 1000,
    tokensInput: 1200,
    tokensOutput: 80,
    tokensReasoning: 25,
    tokensCacheRead: 5360,
    tokensCacheWrite: 7,
  });
  insertMessage(dbPath, {
    id: "msg-a-user",
    sessionId: SESSION_A,
    timeCreated: TURN_1_MS,
    role: "user",
    tokens: null,
  });
  insertMessage(dbPath, {
    id: "msg-a-1",
    sessionId: SESSION_A,
    timeCreated: TURN_1_MS,
    timeUpdated: TURN_1_MS + 5000,
    tokens: { total: 6067, input: 1000, output: 50, reasoning: 10, cache: { read: 5000, write: 7 } },
  });
  insertMessage(dbPath, {
    id: "msg-a-2",
    sessionId: SESSION_A,
    timeCreated: TURN_2_MS,
    tokens: { total: 605, input: 200, output: 30, reasoning: 15, cache: { read: 360, write: 0 } },
  });

  insertSession(dbPath, {
    id: SESSION_B,
    title: "Second fixture session",
    directory: "/home/dev/other-project",
    model: MODEL_B,
    timeCreated: TURN_1_MS - 5000,
    timeUpdated: TURN_1_MS + 500,
    tokensInput: 500,
    tokensOutput: 60,
    tokensReasoning: 40,
    tokensCacheRead: 1500,
  });
  insertMessage(dbPath, {
    id: "msg-b-1",
    sessionId: SESSION_B,
    timeCreated: TURN_1_MS + 250,
    modelId: "mimo-v2.5-pro",
    providerID: "xiaomi-token-plan-sgp",
    tokens: { total: 2100, input: 500, output: 60, reasoning: 40, cache: { read: 1500, write: 0 } },
  });

  insertSession(dbPath, {
    id: SESSION_EMPTY,
    title: "Empty fixture session",
    directory: "/home/dev/empty",
    model: MODEL_A,
    timeCreated: TURN_1_MS,
    timeUpdated: TURN_2_MS,
  });
  insertMessage(dbPath, {
    id: "msg-c-user",
    sessionId: SESSION_EMPTY,
    timeCreated: TURN_1_MS,
    role: "user",
    tokens: null,
  });
  return dbPath;
}

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-opencode-"));
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

// Parity guard: the session browser and the usage parser read the same database,
// so their token sums must match. Impossible to fake — the scanner is forbidden
// from reading the message table for usage, and the parser never looks at the
// session row, so the two only agree if the row really is the messages' sum.
sqliteTest("opencode session totals match the usage parser for the same database", async () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  const tmp = makeHome();
  try {
    const dbPath = writeFixture(home);
    const queuePath = path.join(tmp, "queue.jsonl");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const cursors = {};
    await parseOpencodeDbIncremental({
      dbMessages: readOpencodeDbMessages(dbPath),
      dbPath,
      source: "opencode",
      cursorKey: "opencode",
      cursors,
      queuePath,
      projectQueuePath,
    });
    let parserTotal = 0;
    for (const row of latestBuckets(queuePath).values()) parserTotal += row.total_tokens;

    const rows = await buildSessionAnalytics({ home, force: true });
    const opencodeRows = rows.filter((row) => row.source === "opencode");
    const sessionTotal = opencodeRows.reduce((sum, row) => sum + row.total_tokens, 0);

    assert.equal(parserTotal, 8772, "the two sessions' messages summed by the usage parser");
    assert.equal(opencodeRows.length, 3);
    assert.equal(sessionTotal, parserTotal);
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

sqliteTest("scanOpencodeSession builds one session row per session table row", async () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  try {
    const dbPath = writeFixture(home);
    const sessions = await readOpencodeSessionRows(dbPath);
    assert.equal(sessions.length, 3);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const turnCounts = await readOpencodeSessionTurnCounts(dbPath);
    assert.equal(turnCounts.get(SESSION_A), 3, "user plus the two assistant turns");
    assert.equal(turnCounts.get(SESSION_B), 1);

    const rowA = scanOpencodeSession({
      dbPath,
      sessionId: SESSION_A,
      session: byId.get(SESSION_A),
      turns: turnCounts.get(SESSION_A),
    });
    assert.equal(rowA.source, "opencode");
    assert.equal(rowA.session_id, SESSION_A);
    assert.equal(rowA.title, "Fixture session");
    assert.equal(rowA.model, "deepseek-v4-pro");
    assert.equal(rowA.turns, 3);
    assert.equal(rowA.usage_events, 1, "one aggregate row is one usage event");
    // Straight off the session row's own counters: opencode keeps the disjoint
    // columns, so no inclusive-counter split is involved (unlike ZCode).
    assert.equal(rowA.tokens.input_tokens, 1200);
    assert.equal(rowA.tokens.cached_input_tokens, 5360);
    assert.equal(rowA.tokens.cache_creation_input_tokens, 7);
    assert.equal(rowA.tokens.output_tokens, 80);
    assert.equal(rowA.tokens.reasoning_output_tokens, 25);
    assert.equal(rowA.tokens.total_tokens, 6672);
    assert.equal(rowA.started_at, new Date(TURN_1_MS - 1000).toISOString());
    assert.equal(rowA.ended_at, new Date(TURN_2_MS + 1000).toISOString());
    assert.equal(rowA.project_key, "test");
    assert.equal(rowA.project_ref, "D:/opencode/projectxianmu/test");
    assert.equal(rowA.model_usage.length, 1);
    assert.equal(rowA.model_usage[0].model, "deepseek-v4-pro");
    assert.equal(rowA.model_usage[0].total_tokens, 6672);
    assert.equal(rowA.model_usage[0].usage_events, 1);
    assert.equal(rowA.usage_precision, "reported");
    assert.equal(rowA.cost_is_partial, false);
    assert.equal(rowA.cost_source, "model_pricing");
    assert.equal(rowA.provider_cost_usd, null);
    assert.equal(rowA.provenance.content_retained, false);
    assert.equal(rowA.provenance.source, "local-session-db");
    assert.doesNotMatch(JSON.stringify(rowA), /PRIVATE TRANSCRIPT BODY/);

    const rowB = scanOpencodeSession({
      dbPath,
      sessionId: SESSION_B,
      session: byId.get(SESSION_B),
      turns: turnCounts.get(SESSION_B),
    });
    assert.equal(rowB.session_id, SESSION_B);
    assert.equal(rowB.model, "mimo-v2.5-pro");
    assert.equal(rowB.turns, 1);
    assert.equal(rowB.tokens.input_tokens, 500);
    assert.equal(rowB.tokens.cached_input_tokens, 1500);
    assert.equal(rowB.tokens.output_tokens, 60);
    assert.equal(rowB.tokens.reasoning_output_tokens, 40);
    assert.equal(rowB.tokens.total_tokens, 2100);
    assert.equal(rowB.project_key, "other-project");
    // A session row on its own bounds the session, exactly like the ZCode,
    // AstrBot and OpenBitFun scanners.
    assert.equal(rowB.started_at, new Date(TURN_1_MS - 5000).toISOString());
    assert.equal(rowB.ended_at, new Date(TURN_1_MS + 500).toISOString());
    assert.doesNotMatch(JSON.stringify(rowB), /PRIVATE TRANSCRIPT BODY/);
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("scanOpencodeSession reads the tokens from the session row, not from the messages", async () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  try {
    const dbPath = createOpencodeDb(home);
    insertSession(dbPath, {
      id: SESSION_A,
      title: "Row wins",
      directory: "/home/dev/row-wins",
      model: MODEL_A,
      timeCreated: TURN_1_MS,
      timeUpdated: TURN_2_MS,
      tokensInput: 9999,
      tokensOutput: 111,
    });
    // The message underneath says something else entirely: reading message
    // counters here (the ZCode strategy) would report 1 token instead of 9999.
    insertMessage(dbPath, {
      id: "msg-a-1",
      sessionId: SESSION_A,
      timeCreated: TURN_1_MS,
      tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const sessions = await readOpencodeSessionRows(dbPath);
    const row = scanOpencodeSession({ dbPath, sessionId: SESSION_A, session: sessions[0] });
    assert.equal(row.tokens.input_tokens, 9999);
    assert.equal(row.tokens.output_tokens, 111);
    assert.equal(row.tokens.total_tokens, 10110);
    assert.equal(row.model, "deepseek-v4-pro");
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("scanOpencodeSession reports a session with no counted turn as unavailable", async () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  try {
    const dbPath = writeFixture(home);
    const sessions = await readOpencodeSessionRows(dbPath);
    const empty = sessions.find((session) => session.id === SESSION_EMPTY);
    const turnCounts = await readOpencodeSessionTurnCounts(dbPath);
    const row = scanOpencodeSession({
      dbPath,
      sessionId: SESSION_EMPTY,
      session: empty,
      turns: turnCounts.get(SESSION_EMPTY),
    });
    assert.equal(row.usage_events, 0);
    assert.equal(row.tokens.total_tokens, 0);
    assert.deepEqual(row.model_usage, []);
    assert.equal(row.usage_precision, "unavailable");
    assert.equal(row.provenance.confidence, "partial");
    // Its metadata still describes the session.
    assert.equal(row.turns, 1);
    assert.equal(row.started_at, new Date(TURN_1_MS).toISOString());
    assert.equal(row.ended_at, new Date(TURN_2_MS).toISOString());
    assert.equal(row.model, "deepseek-v4-pro");
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("buildSessionAnalytics discovers opencode sessions from the injected home", async () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  try {
    writeFixture(home);
    const rows = await buildSessionAnalytics({ home, force: true });
    const opencodeRows = rows.filter((row) => row.source === "opencode");
    assert.equal(opencodeRows.length, 3, "every session of the database is browsable");
    assert.deepEqual(
      opencodeRows.map((row) => row.session_id).sort(),
      [SESSION_A, SESSION_B, SESSION_EMPTY].sort(),
    );
    const bySession = new Map(opencodeRows.map((row) => [row.session_id, row]));
    assert.equal(bySession.get(SESSION_A).title, "Fixture session");
    assert.equal(bySession.get(SESSION_A).tokens.input_tokens, 1200);
    assert.equal(bySession.get(SESSION_A).turns, 3);
    assert.equal(bySession.get(SESSION_B).tokens.total_tokens, 2100);
    assert.equal(bySession.get(SESSION_B).project_ref, "/home/dev/other-project");

    // The sidecar is local-only, but it must still carry no transcript and no
    // part payload.
    const sidecar = fs.readFileSync(
      path.join(home, ".tokentracker", "tracker", "session.queue.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(sidecar, /PRIVATE TRANSCRIPT BODY/);
    assert.match(sidecar, /"source":"opencode"/);

    // A rebuild with nothing changed reuses the cached rows.
    const again = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
    assert.equal(again.filter((row) => row.source === "opencode").length, 3);

    // A newly finalized turn moves the database's stat key and rebuilds that
    // session's row without dropping its sibling.
    const dbPath = opencodeDbPath(home);
    insertMessage(dbPath, {
      id: "msg-b-2",
      sessionId: SESSION_B,
      timeCreated: TURN_2_MS,
      modelId: "mimo-v2.5-pro",
      providerID: "xiaomi-token-plan-sgp",
      tokens: { total: 300, input: 300, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    executeSql(dbPath, "UPDATE session SET tokens_input = 800, tokens_cache_read = 1600 WHERE id = '" + SESSION_B + "';");
    const refreshed = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
    const refreshedById = new Map(
      refreshed.filter((row) => row.source === "opencode").map((row) => [row.session_id, row]),
    );
    assert.equal(refreshed.filter((row) => row.source === "opencode").length, 3);
    assert.equal(refreshedById.get(SESSION_B).turns, 2);
    assert.equal(refreshedById.get(SESSION_B).tokens.total_tokens, 2500);
    assert.equal(refreshedById.get(SESSION_A).tokens.total_tokens, 6672);
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

sqliteTest("discovery opens the message table only for a session row with no model", async () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  try {
    const dbPath = createOpencodeDb(home);
    insertSession(dbPath, {
      id: SESSION_A,
      title: "No model on the row",
      directory: "/home/dev/orphan-model",
      // An install that predates the model column (or a row that lost it).
      model: null,
      timeCreated: TURN_1_MS,
      timeUpdated: TURN_2_MS,
      tokensInput: 700,
      tokensOutput: 100,
    });
    insertMessage(dbPath, {
      id: "msg-a-1",
      sessionId: SESSION_A,
      timeCreated: TURN_1_MS,
      modelId: "GLM-5.2",
      providerID: "builtin:zai-start-plan",
      tokens: { total: 800, input: 700, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const rows = await buildSessionAnalytics({ home, force: true });
    const row = rows.filter((entry) => entry.source === "opencode")[0];
    assert.equal(row.model, "GLM-5.2", "the message-level model is the fallback");
    // ...and the tokens still come from the row, not from the message.
    assert.equal(row.tokens.input_tokens, 700);
    assert.equal(row.tokens.total_tokens, 800);
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("opencode resolver honors the data-dir overrides and never widens an injected home", () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  const xdgHome = makeHome();
  const overrideHome = makeHome();
  try {
    const nativeDb = opencodeDbPath(home);
    fs.mkdirSync(path.dirname(nativeDb), { recursive: true });
    fs.writeFileSync(nativeDb, "");
    const xdgDb = path.join(xdgHome, "opencode", "opencode.db");
    fs.mkdirSync(path.dirname(xdgDb), { recursive: true });
    fs.writeFileSync(xdgDb, "");
    const overrideDb = path.join(overrideHome, "opencode.db");
    fs.mkdirSync(path.dirname(overrideDb), { recursive: true });
    fs.writeFileSync(overrideDb, "");

    // The injected home is the whole world: the machine-wide env vars must not
    // drag the developer's real install (or a real HOME) into a fixture run.
    assert.deepEqual(
      resolveOpencodeDbPaths(
        { HOME: "C:\\nope", USERPROFILE: "C:\\nope" },
        { nativeHome: home, homedir: () => path.join("C:\\", "someone-else") },
      ),
      [nativeDb],
    );

    assert.deepEqual(
      resolveOpencodeDbPaths({ XDG_DATA_HOME: xdgHome }, { nativeHome: home }),
      [xdgDb],
    );

    // OPENCODE_HOME names the data directory itself and pins the install: an
    // override whose database is missing must not fall back to another one.
    assert.deepEqual(
      resolveOpencodeDbPaths({ OPENCODE_HOME: overrideHome, XDG_DATA_HOME: xdgHome }, { nativeHome: home }),
      [overrideDb],
    );
    const emptyHome = makeHome();
    try {
      assert.deepEqual(
        resolveOpencodeDbPaths({ OPENCODE_HOME: emptyHome, XDG_DATA_HOME: xdgHome }, { nativeHome: home }),
        [],
      );
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }

    // Nothing installed at all resolves to an empty list, not a phantom path.
    const bare = makeHome();
    try {
      assert.deepEqual(resolveOpencodeDbPaths({}, { nativeHome: bare }), []);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(xdgHome, { recursive: true, force: true });
    fs.rmSync(overrideHome, { recursive: true, force: true });
  }
});

test("opencode resolver reuses sync's WSL resolution shape", () => {
  const restoreEnv = withCleanEnv();
  const home = makeHome();
  const wslHome = makeHome();
  try {
    const nativeDb = opencodeDbPath(home);
    fs.mkdirSync(path.dirname(nativeDb), { recursive: true });
    fs.writeFileSync(nativeDb, "");
    const wslDb = path.join(wslHome, "opencode.db");
    fs.mkdirSync(path.dirname(wslDb), { recursive: true });
    fs.writeFileSync(wslDb, "");
    // The WSL root is only probed for the machine's own home, so make the
    // injected home BE that home and stub the probe itself.
    const deps = {
      nativeHome: home,
      platform: "win32",
      homedir: () => home,
      discoverWslHome: () => wslHome,
    };

    // Default mode is wsl-first (wsl-probe.getWslMode), the same pick
    // resolveInstallPaths makes for sync's opencode paths.
    assert.deepEqual(resolveOpencodeDbPaths({}, deps), [wslDb]);
    assert.deepEqual(
      resolveOpencodeDbPaths({ TOKENTRACKER_WSL_MODE: "native-only" }, deps),
      [nativeDb],
    );
    assert.deepEqual(
      resolveOpencodeDbPaths({ TOKENTRACKER_WSL_MODE: "both" }, deps),
      [nativeDb, wslDb].sort(),
    );

    // An injected home that is NOT the machine's home never reaches for WSL:
    // the probe would splice the live distro into an isolated tree.
    let probed = 0;
    assert.deepEqual(
      resolveOpencodeDbPaths({}, {
        ...deps,
        homedir: () => path.join(os.tmpdir(), "someone-elses-home"),
        discoverWslHome: () => { probed += 1; return wslHome; },
      }),
      [nativeDb],
    );
    assert.equal(probed, 0);

    // The default is a heuristic ("is this the machine's own home?"), so the
    // escape hatch is pinned the same way providerRoots pins it: a caller
    // deliberately scanning a non-default tree can opt back in, and one scanning
    // the real home can opt out.
    assert.deepEqual(
      resolveOpencodeDbPaths({ TOKENTRACKER_WSL_MODE: "both" }, {
        ...deps,
        nativeHome: path.join(os.tmpdir(), "other-profile"),
        homedir: () => path.join(os.tmpdir(), "someone-elses-home"),
        probeWsl: true,
      }),
      [wslDb],
    );
    let optedOut = 0;
    assert.deepEqual(
      resolveOpencodeDbPaths({ TOKENTRACKER_WSL_MODE: "both" }, {
        ...deps,
        probeWsl: false,
        discoverWslHome: () => { optedOut += 1; return wslHome; },
      }),
      [nativeDb],
    );
    assert.equal(optedOut, 0);
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(wslHome, { recursive: true, force: true });
  }
});
