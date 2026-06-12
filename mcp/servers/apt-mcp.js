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
        description: "Search Debian and Ubuntu APT repositories using apt-cache. Finds packages by name, feature, keyword, library, application, development tool, driver, or service. Returns matching package names with short descriptions. Useful for package discovery, software lookup, and dependency research.",
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
        description: "Retrieve detailed package metadata from APT repositories using apt-cache show. Returns version information, dependencies, maintainer details, package size, architecture, repository source, and package description. Useful for package inspection, dependency analysis, and installation planning.",
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
        description: "List packages currently installed on the system using dpkg. Can return all installed packages or filter by package name. Includes package version and architecture information. Useful for inventory auditing, package verification, and dependency troubleshooting.",
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
        description: "Install packages from configured APT repositories using apt-get install. Supports automatic confirmation and dependency resolution. Returns installation output and package manager messages. Useful for software deployment, package provisioning, and system setup automation.",
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
        description: "Remove or purge installed packages using apt-get remove or purge. Supports configuration cleanup and automatic confirmation. Returns package manager output and removal status. Useful for software uninstallation, system cleanup, and package lifecycle management.",
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
        description: "Refresh the local APT package index from configured repositories. Downloads the latest package metadata, repository information, and available version updates. Returns update operation output. Useful before package installation, upgrades, and repository synchronization.",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const { stdout, stderr } = await run("sudo", ["apt-get", "update"]);
            return ok({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
    },

    "apt.upgrade": {
        description: "Upgrade installed packages to the latest available versions from configured repositories. Resolves package updates while preserving installed software. Returns upgrade progress and package manager output. Useful for system maintenance, security updates, and software lifecycle management.",
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
        description: "Remove unused packages and orphaned dependencies no longer required by installed software. Frees disk space and cleans package relationships automatically. Returns package manager output and removal details. Useful for system maintenance, dependency cleanup, and package housekeeping.",
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
        description: "List installed packages that have newer versions available in configured repositories. Returns package names, upgrade information, and current version references. Useful for update planning, system auditing, and package maintenance workflows.",
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
        description: "Clear the local APT package cache and downloaded package archives. Removes cached installation files without affecting installed software. Returns package manager output. Useful for disk space recovery, cache maintenance, and repository housekeeping.",
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