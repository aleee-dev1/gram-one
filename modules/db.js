import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "databases/main.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

export function initDb() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_PATH, err => {
            if (err) return reject(err);
            db.serialize(() => {
                db.run("PRAGMA journal_mode = WAL");
                db.run("PRAGMA foreign_keys = ON");

                db.run(`
                    CREATE TABLE IF NOT EXISTS profiles (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        system_prompt TEXT NOT NULL,
                        created_at INTEGER NOT NULL DEFAULT (unixepoch())
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS conversations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        title TEXT NOT NULL DEFAULT 'New Conversation',
                        profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
                        mcp_servers TEXT,
                        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
                        content TEXT NOT NULL,
                        tool_calls TEXT,
                        tool_call_id TEXT,
                        tool_name TEXT,
                        prompt_tokens INTEGER NOT NULL DEFAULT 0,
                        completion_tokens INTEGER NOT NULL DEFAULT 0,
                        embedding TEXT,
                        created_at INTEGER NOT NULL DEFAULT (unixepoch())
                    )
                `);

                db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)`);

                db.run(`
                    CREATE TABLE IF NOT EXISTS facts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        fact TEXT NOT NULL,
                        embedding TEXT NOT NULL,
                        created_at INTEGER NOT NULL DEFAULT (unixepoch())
                    )
                `);

                db.run("INSERT OR IGNORE INTO profiles (id, name, system_prompt) VALUES (1, 'Mr Daniel', 'You are a helpful assistant')", resolve);
            });
        });
    });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function run(sql, params = []) {
    return new Promise((res, rej) =>
        db.run(sql, params, function (err) { err ? rej(err) : res(this); })
    );
}

function all(sql, params = []) {
    return new Promise((res, rej) =>
        db.all(sql, params, (err, rows) => err ? rej(err) : res(rows))
    );
}

function get(sql, params = []) {
    return new Promise((res, rej) =>
        db.get(sql, params, (err, row) => err ? rej(err) : res(row))
    );
}

function cosine(a, b) {
    const dot = a.reduce((s, v, i) => s + v * b[i], 0);
    const mag = v => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return dot / (mag(a) * mag(b));
}

// ── conversations ─────────────────────────────────────────────────────────────

export function createConversation(profileId, mcpServers) {
    const mcpServersJson = mcpServers ? JSON.stringify(mcpServers) : null;
    return new Promise((res, rej) =>
        db.run("INSERT INTO conversations (profile_id, mcp_servers) VALUES (?, ?)", [profileId || null, mcpServersJson], function (err) {
            err ? rej(err) : res(this.lastID);
        })
    );
}

export async function getConversations() {
    const rows = await all("SELECT id, title, profile_id, mcp_servers, created_at, updated_at FROM conversations ORDER BY updated_at DESC");
    return rows.map(r => { if (r.mcp_servers) r.mcp_servers = JSON.parse(r.mcp_servers); return r; });
}

export async function getConversation(convId) {
    const row = await get("SELECT id, title, profile_id, mcp_servers, created_at, updated_at FROM conversations WHERE id = ?", [convId]);
    if (row?.mcp_servers) row.mcp_servers = JSON.parse(row.mcp_servers);
    return row;
}

export function updateConversationTitle(convId, title) {
    return run("UPDATE conversations SET title = ? WHERE id = ?", [title.trim() || "New Conversation", convId]);
}

export function deleteConversation(convId) {
    return run("DELETE FROM conversations WHERE id = ?", [convId]);
}

// ── messages ──────────────────────────────────────────────────────────────────

export async function getMessages(convId) {
    const rows = await all(
        `SELECT id, role, content, tool_calls, tool_call_id, tool_name, prompt_tokens, completion_tokens, created_at
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
        [convId]
    );
    return rows.map(r => { if (r.tool_calls) r.tool_calls = JSON.parse(r.tool_calls); return r; });
}

export async function saveMessage(convId, role, content, promptTokens, completionTokens, extra = {}) {
    const tool_calls = extra.tool_calls ? JSON.stringify(extra.tool_calls) : null;
    const embedding = extra.embedding ? JSON.stringify(extra.embedding) : null;
    const result = await run(
        `INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id, tool_name, prompt_tokens, completion_tokens, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [convId, role, content || "", tool_calls, extra.tool_call_id || null, extra.tool_name || null,
         promptTokens || 0, completionTokens || 0, embedding]
    );
    await run("UPDATE conversations SET updated_at = unixepoch() WHERE id = ?", [convId]);
    return result.lastID;
}

// ── RAG: messages ─────────────────────────────────────────────────────────────

export async function getRelevantMessages(convId, queryEmbedding, topK = 3, recentK = 4) {
    const rows = await all(
        `SELECT id, role, content, embedding FROM messages
         WHERE conversation_id = ? AND embedding IS NOT NULL AND role IN ('user', 'assistant')
         ORDER BY created_at ASC, id ASC`,
        [convId]
    );
    const parsed = rows.map(r => ({ ...r, embedding: JSON.parse(r.embedding) }));
    const recent = parsed.slice(-recentK);
    const recentIds = new Set(recent.map(r => r.id));
    const topSimilar = parsed
        .filter(r => !recentIds.has(r.id))
        .map(r => ({ ...r, score: cosine(queryEmbedding, r.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    return [...recent, ...topSimilar];
}

// ── RAG: facts ────────────────────────────────────────────────────────────────

export async function getAllFacts() {
    return all("SELECT id, fact FROM facts ORDER BY created_at ASC");
}

export async function saveFacts(facts, embedFn) {
    const existing = await all("SELECT fact, embedding FROM facts");
    const parsed = existing.map(r => ({ ...r, embedding: JSON.parse(r.embedding) }));
    const saved = [];

    for (const fact of facts) {
        const emb = await embedFn(fact);
        const duplicate = parsed.some(r => cosine(emb, r.embedding) > 0.95);
        if (!duplicate) {
            await run("INSERT INTO facts (fact, embedding) VALUES (?, ?)", [fact, JSON.stringify(emb)]);
            parsed.push({ fact, embedding: emb });
            saved.push(fact);
        }
    }
    return saved;
}

// ── profiles ──────────────────────────────────────────────────────────────────

export function getProfiles() {
    return all("SELECT id, name, system_prompt, created_at FROM profiles ORDER BY name ASC");
}

export function getProfile(id) {
    return get("SELECT id, name, system_prompt, created_at FROM profiles WHERE id = ?", [id]);
}

export function createProfile(name, systemPrompt) {
    return new Promise((res, rej) =>
        db.run("INSERT INTO profiles (name, system_prompt) VALUES (?, ?)", [name, systemPrompt], function (err) {
            err ? rej(err) : res(this.lastID);
        })
    );
}

export function updateProfile(id, name, systemPrompt) {
    return run("UPDATE profiles SET name = ?, system_prompt = ? WHERE id = ?", [name, systemPrompt, id]);
}

export function deleteProfile(id) {
    return run("DELETE FROM profiles WHERE id = ?", [id]);
}