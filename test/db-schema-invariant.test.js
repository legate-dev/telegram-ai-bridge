import fs from "node:fs"
import { readFile } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { after, test } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN ??= "123456:TESTTOKEN"
process.env.LOG_LEVEL ??= "error"

// Redirect the DB to a temp directory so the test leaves no artefacts.
// BRIDGE_DB_PATH must be set before src/config.js is evaluated.
const testDir = await mkdtemp(join(tmpdir(), "tbridge-schema-"))
process.env.BRIDGE_DB_PATH = join(testDir, "test.db")

const { getDb } = await import("../src/db.js")

// Async cleanup via node:test `after()` hook. Using process.on("exit") here
// would silently leak the temp directory because exit handlers must be
// synchronous — any pending Promise (including the one from fs.promises.rm)
// is abandoned when the process exits.
after(async () => {
  await rm(testDir, { recursive: true }).catch(() => {})
})

// ── helpers ────────────────────────────────────────────────────────────────

const DB_SRC = resolve(fileURLToPath(import.meta.url), "../../src/db.js")

/** SQL constraint keywords that open a table-level constraint clause, not a column. */
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  "PRIMARY",
  "UNIQUE",
  "CHECK",
  "FOREIGN",
  "CONSTRAINT",
])

/**
 * Parse all `CREATE TABLE IF NOT EXISTS <name> (...)` blocks from SQL source
 * and return a map of { tableName → Set<columnName> }.
 */
function parseCreateTableCols(src) {
  const result = new Map()
  // Match each CREATE TABLE block; the body is everything inside the outermost parens.
  const tableRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*;/gi
  let m
  while ((m = tableRe.exec(src)) !== null) {
    const tableName = m[1]
    const body = m[2]
    const cols = new Set()
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim().replace(/,$/, "").trim()
      if (!line) continue
      const firstWord = line.split(/\s+/)[0].toUpperCase()
      if (TABLE_CONSTRAINT_KEYWORDS.has(firstWord)) continue
      cols.add(line.split(/\s+/)[0])
    }
    result.set(tableName, cols)
  }
  return result
}

/**
 * Parse all `ALTER TABLE <name> ADD COLUMN <col>` statements from SQL source
 * and return a map of { tableName → Set<columnName> }.
 */
function parseAlterTableCols(src) {
  const result = new Map()
  const alterRe = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi
  let m
  while ((m = alterRe.exec(src)) !== null) {
    const tableName = m[1]
    const colName = m[2]
    if (!result.has(tableName)) result.set(tableName, new Set())
    result.get(tableName).add(colName)
  }
  return result
}

// ── tests ──────────────────────────────────────────────────────────────────

test("db schema CREATE matches ALTER migrations (no drift)", async () => {
  const src = await readFile(DB_SRC, "utf8")

  const createCols = parseCreateTableCols(src)
  const alterCols = parseAlterTableCols(src)

  assert.ok(createCols.size > 0, "should find at least one CREATE TABLE block")

  for (const [table, alteredCols] of alterCols) {
    const declared = createCols.get(table)
    assert.ok(
      declared !== undefined,
      `ALTER TABLE references table "${table}" which has no CREATE TABLE block in src/db.js`,
    )
    for (const col of alteredCols) {
      assert.ok(
        declared.has(col),
        `Column "${col}" is added via ALTER TABLE ${table} ADD COLUMN but is missing from the CREATE TABLE ${table} declaration in src/db.js — update CREATE TABLE to include it`,
      )
    }
  }
})

test("db live schema matches CREATE TABLE declarations (no missing columns)", async () => {
  const src = await readFile(DB_SRC, "utf8")
  const createCols = parseCreateTableCols(src)

  // Initialise the DB (runs CREATE TABLE + migrations)
  const db = getDb()

  for (const [table, declaredCols] of createCols) {
    // Table names are extracted via /\w+/ so only [a-zA-Z0-9_] chars are possible,
    // but assert that explicitly before interpolating into the PRAGMA statement.
    assert.match(table, /^\w+$/, `Unexpected table name format: "${table}"`)
    const liveCols = new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
    )
    for (const col of declaredCols) {
      assert.ok(
        liveCols.has(col),
        `Column "${col}" is declared in CREATE TABLE ${table} in src/db.js but does not exist in the live SQLite schema`,
      )
    }
  }
})
