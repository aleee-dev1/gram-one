import sqlite3 from 'sqlite3';
sqlite3.verbose();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
let dir = path.dirname(__filename);

while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Root not found");
    dir = parent;
}

const ROOT = dir;

const resolveRoot = (...p) => path.join(ROOT, ...p);

const db = new sqlite3.Database(resolveRoot('./databases/sandbox.db'));

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function validateTableName(name) {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        throw new Error(`Invalid identifier: "${name}"`);
    }
}

function validateItemObject(item, requireId = false) {
    if (typeof item !== 'object' || item === null) throw new Error('Item must be a non-null object');
    if (requireId && (!item.id || typeof item.id !== 'number')) throw new Error('Item must have a numeric id');
}

function mapType(value) {
    switch (typeof value) {
        case 'number': return Number.isInteger(value) ? 'INTEGER' : 'REAL';
        case 'boolean': return 'INTEGER';
        case 'object': return 'TEXT';
        default: return 'TEXT';
    }
}

function serializeValue(value) {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
}

function deserializeRow(row, fields) {
    const objectFields = new Set(fields.filter(f => f.type === 'TEXT' && f.isObject).map(f => f.name));
    const result = { id: row.id };
    for (const [key, val] of Object.entries(row)) {
        if (key === 'id') continue;
        try {
            result[key] = objectFields.has(key) ? JSON.parse(val) : val;
        } catch {
            result[key] = val;
        }
    }
    return result;
}

async function initSchemasTable() {
    await run(`CREATE TABLE IF NOT EXISTS _schemas (
        table_name TEXT PRIMARY KEY,
        schema TEXT NOT NULL
    )`);
}

async function getSchema(tableName) {
    const row = await get(`SELECT schema FROM _schemas WHERE table_name = ?`, [tableName]);
    if (!row) throw new Error(`No schema found for table "${tableName}"`);
    return JSON.parse(row.schema);
}

function validateAgainstSchema(itemObject, fields, requireAll = false) {
    const fieldMap = Object.fromEntries(fields.map(f => [f.name, f]));
    for (const [key, val] of Object.entries(itemObject)) {
        if (key === 'id') continue;
        if (!fieldMap[key]) throw new Error(`Unknown field "${key}" for this table`);
        const expected = fieldMap[key].type;
        const actual = mapType(val);
        if (actual !== expected) throw new Error(`Type mismatch for "${key}": expected ${expected}, got ${actual}`);
    }
    if (requireAll) {
        for (const f of fields) {
            if (!(f.name in itemObject)) throw new Error(`Missing required field "${f.name}"`);
        }
    }
}

// --- Table-scoped instance ---

function tableScope(tableName) {
    validateTableName(tableName);

    return {
        async getAllItems(itemIds = null) {
            try {
                const fields = await getSchema(tableName);
                let rows;
                if (Array.isArray(itemIds) && itemIds.length) {
                    if (!itemIds.every(id => typeof id === 'number')) throw new Error('All itemIds must be numbers');
                    const placeholders = itemIds.map(() => '?').join(',');
                    rows = await all(`SELECT * FROM ${tableName} WHERE id IN (${placeholders})`, itemIds);
                } else {
                    rows = await all(`SELECT * FROM ${tableName}`);
                }
                return rows.map(r => deserializeRow(r, fields));
            } catch (err) {
                throw new Error(`Failed to get items from "${tableName}": ${err.message}`);
            }
        },

        async eq(fieldName, value) {
            try {
                validateTableName(fieldName);
                const fields = await getSchema(tableName);
                const field = fields.find(f => f.name === fieldName);
                if (!field) throw new Error(`Unknown field "${fieldName}" in table "${tableName}"`);
                const rows = await all(`SELECT * FROM ${tableName} WHERE ${fieldName} = ?`, [value]);
                return rows.map(r => deserializeRow(r, fields));
            } catch (err) {
                throw new Error(`Failed to query "${tableName}": ${err.message}`);
            }
        },

        async contains(fieldName, keyword) {
            try {
                validateTableName(fieldName);
                const fields = await getSchema(tableName);
                const field = fields.find(f => f.name === fieldName);
                if (!field) throw new Error(`Unknown field "${fieldName}" in table "${tableName}"`);
                const rows = await all(
                    `SELECT * FROM ${tableName} WHERE LOWER(${fieldName}) LIKE LOWER(?)`,
                    [`%${keyword}%`]
                );
                return rows.map(r => deserializeRow(r, fields));
            } catch (err) {
                throw new Error(`Failed to search "${tableName}": ${err.message}`);
            }
        },

        async createItem(itemObject) {
            try {
                validateItemObject(itemObject);
                const fields = await getSchema(tableName);
                validateAgainstSchema(itemObject, fields, true);
                const cols = fields.map(f => f.name);
                const vals = cols.map(c => serializeValue(itemObject[c]));
                const placeholders = cols.map(() => '?').join(', ');
                const result = await run(
                    `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`,
                    vals
                );
                return `Item created with id "${result.lastID}"`;
            } catch (err) {
                throw new Error(`Failed to create item in "${tableName}": ${err.message}`);
            }
        },

        async updateItem(itemObject) {
            try {
                validateItemObject(itemObject, true);
                const fields = await getSchema(tableName);
                validateAgainstSchema(itemObject, fields, false);
                const updatableFields = Object.keys(itemObject).filter(k => k !== 'id');
                const set = updatableFields.map(f => `${f} = ?`).join(', ');
                const vals = [...updatableFields.map(f => serializeValue(itemObject[f])), itemObject.id];
                await run(`UPDATE ${tableName} SET ${set} WHERE id = ?`, vals);
                return `Item ${itemObject.id} updated in "${tableName}"`;
            } catch (err) {
                throw new Error(`Failed to update item in "${tableName}": ${err.message}`);
            }
        },

        async removeItem(itemId) {
            try {
                if (typeof itemId !== 'number') throw new Error('Item id must be a number');
                await run(`DELETE FROM ${tableName} WHERE id = ?`, [itemId]);
                return `Item ${itemId} deleted from "${tableName}"`;
            } catch (err) {
                throw new Error(`Failed to remove item from "${tableName}": ${err.message}`);
            }
        },
    };
}

// --- Top-level database export ---

export async function initDb() {
    await initSchemasTable();
}

export const database = Object.assign(
    (tableName) => tableScope(tableName),
    {
        async createTable(name, sampleObject) {
            try {
                validateTableName(name);
                validateItemObject(sampleObject);
                const fields = Object.entries(sampleObject).map(([key, val]) => {
                    validateTableName(key);
                    const type = mapType(val);
                    return { name: key, type, isObject: type === 'TEXT' && typeof val === 'object' && val !== null };
                });
                const cols = fields.map(f => `${f.name} ${f.type}`).join(', ');
                await run(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols})`);
                await run(`INSERT OR REPLACE INTO _schemas (table_name, schema) VALUES (?, ?)`, [name, JSON.stringify(fields)]);
                return `Table "${name}" created`;
            } catch (err) {
                throw new Error(`Failed to create table "${name}": ${err.message}`);
            }
        },

        async removeTable(name) {
            try {
                validateTableName(name);
                await run(`DROP TABLE IF EXISTS ${name}`);
                await run(`DELETE FROM _schemas WHERE table_name = ?`, [name]);
                return `Table "${name}" removed`;
            } catch (err) {
                throw new Error(`Failed to drop table "${name}": ${err.message}`);
            }
        },

        async clearTable(name) {
            try {
                validateTableName(name);
                await run(`DELETE FROM ${name}`);
                await run(`DELETE FROM sqlite_sequence WHERE name = ?`, [name]);
                return `Table "${name}" cleared`;
            } catch (err) {
                throw new Error(`Failed to clear table "${name}": ${err.message}`);
            }
        },

        async getAllTables() {
            try {
                const rows = await all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_schemas'`);
                return rows.map(r => r.name);
            } catch (err) {
                throw new Error(`Failed to fetch table list: ${err.message}`);
            }
        }
    }
);