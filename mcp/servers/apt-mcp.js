#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";

const execFileAsync = promisify(execFile);

const ok   = data => ({ success: true, content: data });
const fail = err  => ({ success: false, content: err?.stderr || err?.message || String(err) });
const send = obj  => process.stdout.write(JSON.stringify(obj) + "\n");
const res  = (id, result) => send({ jsonrpc: "2.0", id, result });

async function run(cmd, args = []) {
    return execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 * 20 });
}

function text(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

const TOOLS = {
    "apt.search": {
        description: "Search for packages in apt-cache",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
        },
        async handler({ query }) {
            const { stdout } = await run("apt-cache", ["search", query]);
            const packages = stdout.split("\n").filter(Boolean).map(line => {
                const idx = line.indexOf(" - ");
                if (idx === -1) return { package: line.trim(), description: "" };
                return { package: line.slice(0, idx).trim(), description: line.slice(idx + 3).trim() };
            });
            return ok(packages);
        }
    },

    "apt.info": {
        description: "Show apt-cache info for a package",
        inputSchema: {
            type: "object",
            properties: { package: { type: "string" } },
            required: ["package"]
        },
        async handler({ package: pkg }) {
            const { stdout } = await run("apt-cache", ["show", pkg]);
            return ok({ package: pkg, raw: stdout.trim() });
        }
    },

    "apt.installed": {
        description: "List installed packages, optionally filtered by name",
        inputSchema: {
            type: "object",
            properties: { package: { type: "string" } },
            required: []
        },
        async handler({ package: pkg }) {
            const args = ["-l"];
            if (pkg) args.push(pkg);
            const { stdout } = await run("dpkg", args);
            const packages = stdout.split("\n").filter(l => l.startsWith("ii")).map(line => {
                const parts = line.trim().split(/\s+/);
                return { package: parts[1], version: parts[2], architecture: parts[3] };
            });
            return ok(packages);
        }
    },

    "apt.install": {
        description: "Install a package via apt-get",
        inputSchema: {
            type: "object",
            properties: {
                package:   { type: "string" },
                assumeYes: { type: "boolean", default: true }
            },
            required: ["package"]
        },
        async handler({ package: pkg, assumeYes = true }) {
            const args = ["apt-get", "install"];
            if (assumeYes) args.push("-y");
            args.push(pkg);
            const { stdout, stderr } = await run("sudo", args);
            return ok({ package: pkg, stdout: stdout.trim(), stderr: stderr.trim() });
        }
    },

    "apt.remove": {
        description: "Remove or purge a package via apt-get",
        inputSchema: {
            type: "object",
            properties: {
                package:   { type: "string" },
                purge:     { type: "boolean", default: false },
                assumeYes: { type: "boolean", default: true }
            },
            required: ["package"]
        },
        async handler({ package: pkg, purge = false, assumeYes = true }) {
            const args = ["apt-get", purge ? "purge" : "remove"];
            if (assumeYes) args.push("-y");
            args.push(pkg);
            const { stdout, stderr } = await run("sudo", args);
            return ok({ package: pkg, purge, stdout: stdout.trim(), stderr: stderr.trim() });
        }
    },

    "apt.update": {
        description: "Run apt-get update",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const { stdout, stderr } = await run("sudo", ["apt-get", "update"]);
            return ok({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
    },

    "apt.upgrade": {
        description: "Run apt-get upgrade",
        inputSchema: {
            type: "object",
            properties: { assumeYes: { type: "boolean", default: true } },
            required: []
        },
        async handler({ assumeYes = true }) {
            const args = ["apt-get", "upgrade"];
            if (assumeYes) args.push("-y");
            const { stdout, stderr } = await run("sudo", args);
            return ok({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
    },

    "apt.autoremove": {
        description: "Run apt-get autoremove",
        inputSchema: {
            type: "object",
            properties: { assumeYes: { type: "boolean", default: true } },
            required: []
        },
        async handler({ assumeYes = true }) {
            const args = ["apt-get", "autoremove"];
            if (assumeYes) args.push("-y");
            const { stdout, stderr } = await run("sudo", args);
            return ok({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
    },

    "apt.listUpgradable": {
        description: "List upgradable packages",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const { stdout } = await run("apt", ["list", "--upgradable"]);
            const packages = stdout.split("\n").slice(1).filter(Boolean).map(line => {
                const [pkgPart, versionPart] = line.split(" upgradable from: ");
                return {
                    package:    pkgPart?.split("/")[0]?.trim(),
                    raw:        line.trim(),
                    oldVersion: versionPart?.replace("]", "").trim(),
                };
            });
            return ok(packages);
        }
    },

    "apt.clean": {
        description: "Run apt-get clean",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const { stdout, stderr } = await run("sudo", ["apt-get", "clean"]);
            return ok({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
    },
};

// --- MCP stdio transport ---

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    const { id, method, params } = msg;

    if (method === "initialize") {
        return res(id, {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "apt-mcp", version: "1.0.0" },
            capabilities: { tools: {} }
        });
    }

    if (method === "notifications/initialized") return;

    if (method === "tools/list") {
        return res(id, {
            tools: Object.entries(TOOLS).map(([name, t]) => ({
                name,
                description: t.description,
                inputSchema: t.inputSchema
            }))
        });
    }

    if (method === "tools/call") {
        const { name, arguments: args = {} } = params;
        const tool = TOOLS[name];
        if (!tool) return res(id, text(fail(`Unknown tool: ${name}`)));
        try {
            return res(id, text(await tool.handler(args)));
        } catch (e) {
            return res(id, text(fail(e)));
        }
    }

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});