#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

// --- Config path ---
const SSH_CONFIG_PATH = process.env.SSH_CONFIG_PATH || process.argv[2] || path.join(os.homedir(), ".ssh", "config");

// --- Parser: ssh config text -> JS object ---
// Returns: { hosts: { [hostAlias]: { _order: n, fields: { [key]: value|value[] } } }, globals: { [key]: value|value[] } }
function parseConfig(text) {
    const lines = text.split("\n");
    const result = { hosts: {}, globals: {}, _hostOrder: [] };
    let currentHost = null;
    let hostOrder = 0;

    for (let raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;

        const m = line.match(/^(\S+)\s+(.+)$/);
        if (!m) continue;
        const [, key, val] = m;
        const keyLow = key.toLowerCase();

        if (keyLow === "host") {
            currentHost = val.trim();
            result.hosts[currentHost] = { _order: hostOrder++, fields: {} };
            result._hostOrder.push(currentHost);
        } else if (currentHost) {
            const f = result.hosts[currentHost].fields;
            if (f[key]) {
                f[key] = Array.isArray(f[key]) ? [...f[key], val] : [f[key], val];
            } else {
                f[key] = val;
            }
        } else {
            if (result.globals[key]) {
                result.globals[key] = Array.isArray(result.globals[key])
                    ? [...result.globals[key], val]
                    : [result.globals[key], val];
            } else {
                result.globals[key] = val;
            }
        }
    }
    return result;
}

// --- Serializer: JS object -> ssh config text ---
function serializeConfig(config) {
    const lines = [];

    // Globals first
    for (const [k, v] of Object.entries(config.globals)) {
        if (Array.isArray(v)) v.forEach(val => lines.push(`${k} ${val}`));
        else lines.push(`${k} ${v}`);
    }
    if (lines.length) lines.push("");

    for (const alias of config._hostOrder) {
        const host = config.hosts[alias];
        if (!host) continue;
        lines.push(`Host ${alias}`);
        for (const [k, v] of Object.entries(host.fields)) {
            if (Array.isArray(v)) v.forEach(val => lines.push(`  ${k} ${val}`));
            else lines.push(`  ${k} ${v}`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

// --- File I/O ---
function loadConfig() {
    if (!fs.existsSync(SSH_CONFIG_PATH)) return { hosts: {}, globals: {}, _hostOrder: [] };
    return parseConfig(fs.readFileSync(SSH_CONFIG_PATH, "utf8"));
}

function saveConfig(config) {
    const backupPath = SSH_CONFIG_PATH + ".bak";
    if (fs.existsSync(SSH_CONFIG_PATH)) fs.copyFileSync(SSH_CONFIG_PATH, backupPath);
    fs.writeFileSync(SSH_CONFIG_PATH, serializeConfig(config), "utf8");
}

// --- Response helpers ---
const ok = data => JSON.stringify({ success: true, content: data });
const err = msg => JSON.stringify({ success: false, content: msg });

// --- State ---
let config = loadConfig();

// --- Tools ---
const TOOLS = {
    // List all hosts
    "ssh_config_get_all": {
        description: "Get all hosts from SSH config as JSON",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler() {
            const out = {};
            for (const alias of config._hostOrder) {
                out[alias] = config.hosts[alias].fields;
            }
            return ok(out);
        }
    },

    // Get single host
    "ssh_config_get_host": {
        description: "Get a single host entry by alias",
        inputSchema: {
            type: "object",
            properties: { host: { type: "string", description: "Host alias" } },
            required: ["host"]
        },
        handler({ host }) {
            if (!config.hosts[host]) return err(`Host '${host}' not found`);
            return ok({ host, fields: config.hosts[host].fields });
        }
    },

    // Add host (fails if exists)
    "ssh_config_add_host": {
        description: "Add a new host entry. Required: host alias + at least HostName. Fails if alias already exists.",
        inputSchema: {
            type: "object",
            properties: {
                host: { type: "string", description: "Host alias" },
                HostName: { type: "string", description: "Remote hostname or IP" },
                User: { type: "string" },
                Port: { type: "string" },
                IdentityFile: { type: "string" },
                ExtraFields: { type: "object", description: "Any additional valid SSH config key/value pairs" }
            },
            required: ["host", "HostName"]
        },
        handler({ host, HostName, ExtraFields = {}, ...rest }) {
            if (config.hosts[host]) return err(`Host '${host}' already exists. Use ssh_config_set_field to update.`);
            const fields = { HostName, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null)), ...ExtraFields };
            config.hosts[host] = { _order: config._hostOrder.length, fields };
            config._hostOrder.push(host);
            saveConfig(config);
            return ok({ host, fields });
        }
    },

    // Set (upsert) a single field on a host
    "ssh_config_set_field": {
        description: "Set or update a single field on an existing or new host",
        inputSchema: {
            type: "object",
            properties: {
                host: { type: "string", description: "Host alias" },
                key: { type: "string", description: "SSH config key (e.g. HostName, User, Port)" },
                value: { type: "string", description: "Value to set" }
            },
            required: ["host", "key", "value"]
        },
        handler({ host, key, value }) {
            if (!config.hosts[host]) {
                config.hosts[host] = { _order: config._hostOrder.length, fields: {} };
                config._hostOrder.push(host);
            }
            config.hosts[host].fields[key] = value;
            saveConfig(config);
            return ok({ host, key, value });
        }
    },

    // Remove a single field from a host
    "ssh_config_remove_field": {
        description: "Remove a single field from a host entry",
        inputSchema: {
            type: "object",
            properties: {
                host: { type: "string" },
                key: { type: "string" }
            },
            required: ["host", "key"]
        },
        handler({ host, key }) {
            if (!config.hosts[host]) return err(`Host '${host}' not found`);
            if (!(key in config.hosts[host].fields)) return err(`Field '${key}' not found on host '${host}'`);
            delete config.hosts[host].fields[key];
            saveConfig(config);
            return ok({ host, removed: key });
        }
    },

    // Remove entire host
    "ssh_config_remove_host": {
        description: "Remove an entire host entry",
        inputSchema: {
            type: "object",
            properties: { host: { type: "string" } },
            required: ["host"]
        },
        handler({ host }) {
            if (!config.hosts[host]) return err(`Host '${host}' not found`);
            delete config.hosts[host];
            config._hostOrder = config._hostOrder.filter(h => h !== host);
            saveConfig(config);
            return ok({ removed: host });
        }
    },

    // Rename host alias
    "ssh_config_rename_host": {
        description: "Rename a host alias without changing its fields",
        inputSchema: {
            type: "object",
            properties: {
                host: { type: "string", description: "Current alias" },
                newHost: { type: "string", description: "New alias" }
            },
            required: ["host", "newHost"]
        },
        handler({ host, newHost }) {
            if (!config.hosts[host]) return err(`Host '${host}' not found`);
            if (config.hosts[newHost]) return err(`Host '${newHost}' already exists`);
            config.hosts[newHost] = config.hosts[host];
            delete config.hosts[host];
            config._hostOrder = config._hostOrder.map(h => h === host ? newHost : h);
            saveConfig(config);
            return ok({ renamed: { from: host, to: newHost } });
        }
    },

    // Reload config from disk
    "ssh_config_reload": {
        description: "Reload the SSH config file from disk into memory",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler() {
            config = loadConfig();
            return ok({ reloaded: SSH_CONFIG_PATH, hosts: config._hostOrder });
        }
    },

    // Get config file path in use
    "ssh_config_info": {
        description: "Return the config file path and host count",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler() {
            return ok({ path: SSH_CONFIG_PATH, hostCount: config._hostOrder.length, hosts: config._hostOrder });
        }
    }
};

// --- MCP stdio transport ---
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    const { id, method, params } = msg;

    if (method === "initialize") {
        return send({
            jsonrpc: "2.0", id,
            result: {
                protocolVersion: "2024-11-05",
                serverInfo: { name: "ssh-config-mcp", version: "1.0.0" },
                capabilities: { tools: {} }
            }
        });
    }

    if (method === "notifications/initialized") return;

    if (method === "tools/list") {
        return send({
            jsonrpc: "2.0", id,
            result: {
                tools: Object.entries(TOOLS).map(([name, t]) => ({
                    name,
                    description: t.description,
                    inputSchema: t.inputSchema
                }))
            }
        });
    }

    if (method === "tools/call") {
        const { name, arguments: args = {} } = params;
        const tool = TOOLS[name];
        if (!tool) {
            return send({
                jsonrpc: "2.0", id,
                result: { content: [{ type: "text", text: err(`Unknown tool: ${name}`) }] }
            });
        }
        let result;
        try { result = tool.handler(args); }
        catch (e) { result = err(e.message); }
        return send({
            jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: result }] }
        });
    }

    // Unknown method
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});
