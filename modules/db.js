import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { ChromaClient } from "chromadb";

const chromaClient = new ChromaClient({ host: "localhost", port: 8000 });
let messagesCollection;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../databases/main.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

export async function initDb() {
    try {
        messagesCollection = await chromaClient.getOrCreateCollection({
            name: "messages",
            metadata: { "hnsw:space": "cosine" },
            embeddingFunction: { generate: async (texts) => { throw new Error("unused"); } }
        });
    } catch (e) {
        console.error("ChromaDB init error:", e);
    }

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
                    CREATE TABLE IF NOT EXISTS mcp_servers_meta (
                        server_name TEXT PRIMARY KEY,
                        shasum TEXT
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS mcp_tools (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        server_name TEXT,
                        tool_name TEXT,
                        description TEXT,
                        parameters TEXT,
                        embedding TEXT,
                        UNIQUE(server_name, tool_name)
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS config (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        base_url TEXT NOT NULL,
                        api_key TEXT NOT NULL,
                        tavily_api_key TEXT,
                        search_engine TEXT,
                        searxng_base_url TEXT,
                        searxng_port TEXT
                    )
                `);
                
                db.run("ALTER TABLE config ADD COLUMN tavily_api_key TEXT", () => {});
                db.run("ALTER TABLE config ADD COLUMN search_engine TEXT", () => {});
                db.run("ALTER TABLE config ADD COLUMN searxng_base_url TEXT", () => {});
                db.run("ALTER TABLE config ADD COLUMN searxng_port TEXT", () => {});

                db.run("INSERT OR IGNORE INTO config (id, base_url, api_key) VALUES (1, ?, ?)", [
                    'https://api.mistral.ai', process.env.MISTRAL_API_KEY || ''
                ]);

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

// ── config ────────────────────────────────────────────────────────────────────

export function getConfig() {
    return get("SELECT base_url, api_key, tavily_api_key, search_engine, searxng_base_url, searxng_port FROM config WHERE id = 1");
}

export function updateConfig(baseUrl, apiKey, tavilyApiKey, searchEngine, searxngBaseUrl, searxngPort) {
    return run("UPDATE config SET base_url = ?, api_key = ?, tavily_api_key = ?, search_engine = ?, searxng_base_url = ?, searxng_port = ? WHERE id = 1", [baseUrl, apiKey, tavilyApiKey, searchEngine, searxngBaseUrl, searxngPort]);
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
        `SELECT id, role, content, tool_calls, tool_call_id, tool_name, prompt_tokens, completion_tokens, embedding, created_at
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
        [convId]
    );
    return rows.map(r => {
        if (r.tool_calls) r.tool_calls = JSON.parse(r.tool_calls);
        if (r.embedding) r.embedding = JSON.parse(r.embedding);
        return r;
    });
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

    if (extra.embedding && messagesCollection) {
        try {
            await messagesCollection.add({
                ids: [result.lastID.toString()],
                embeddings: [extra.embedding],
                metadatas: [{ conversation_id: Number(convId), role: role, created_at: Date.now() }],
                documents: [content || ""]
            });
        } catch (e) {
            console.error("Chroma DB add error:", e);
        }
    }

    return result.lastID;
}

// ── RAG: messages ─────────────────────────────────────────────────────────────

export async function getRelevantMessages(convId, queryEmbedding, topK = 5, recentK = 3) {
    const recentRows = await all(
        `SELECT id FROM messages 
         WHERE conversation_id = ? AND role IN ('user', 'assistant') 
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [convId, recentK]
    );
    const recentIds = new Set(recentRows.map(r => r.id.toString()));

    let topSimilar = [];
    if (messagesCollection) {
        try {
            const results = await messagesCollection.query({
                queryEmbeddings: [queryEmbedding],
                nResults: topK + recentK,
                where: {
                    "$and": [
                        { "conversation_id": { "$eq": Number(convId) } },
                        { "role": { "$in": ["user", "assistant"] } }
                    ]
                }
            });
            if (results.ids && results.ids[0]) {
                const ids = results.ids[0];
                const metadatas = results.metadatas[0];
                const documents = results.documents[0];

                for (let i = 0; i < ids.length; i++) {
                    if (!recentIds.has(ids[i])) {
                        topSimilar.push({
                            id: parseInt(ids[i]),
                            role: metadatas[i].role,
                            content: documents[i]
                        });
                        if (topSimilar.length >= topK) break;
                    }
                }
            }
        } catch (e) {
            console.error("Chroma query error:", e);
        }
    }
    return topSimilar;
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

// ── mcp ───────────────────────────────────────────────────────────────────────

export async function getMcpServerMeta(serverName) {
    return get("SELECT shasum FROM mcp_servers_meta WHERE server_name = ?", [serverName]);
}

export async function updateMcpServerMeta(serverName, shasum) {
    return run("INSERT OR REPLACE INTO mcp_servers_meta (server_name, shasum) VALUES (?, ?)", [serverName, shasum]);
}

export async function clearMcpTools(serverName) {
    return run("DELETE FROM mcp_tools WHERE server_name = ?", [serverName]);
}

export async function saveMcpTool(serverName, toolName, description, parameters, embedding) {
    return run(
        "INSERT INTO mcp_tools (server_name, tool_name, description, parameters, embedding) VALUES (?, ?, ?, ?, ?)",
        [serverName, toolName, description, JSON.stringify(parameters), JSON.stringify(embedding)]
    );
}

export async function getTopTools(queryEmbedding, allowedServers, topK = 5) {
    const rows = await all("SELECT server_name, tool_name, description, parameters, embedding FROM mcp_tools");
    const parsed = rows.map(r => ({ ...r, embedding: JSON.parse(r.embedding) }));
    const filtered = allowedServers ? parsed.filter(r => allowedServers.includes(r.server_name)) : parsed;
    if (!queryEmbedding) return filtered.slice(0, topK).map(r => ({
        type: "function",
        function: { name: `${r.server_name}__${r.tool_name}`, description: r.description, parameters: JSON.parse(r.parameters) }
    }));
    const threshold = 0.60;
    const scored = filtered
        .map(r => ({
            ...r,
            score: cosine(queryEmbedding, r.embedding)
        }))
        .filter(r => r.score >= threshold)
        .sort((a, b) => b.score - a.score);

    console.log("\nTool ranking:");
    for (const t of scored.slice(0, 20)) {
        console.log(
            `${t.score.toFixed(2)}  ${t.server_name}__${t.tool_name}`
        );
    }

    const top = scored.slice(0, topK);

    return top.map(r => ({
        type: "function",
        function: {
            name: `${r.server_name}__${r.tool_name}`,
            description: r.description,
            parameters: JSON.parse(r.parameters)
        }
    }));
}