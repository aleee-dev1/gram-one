#!/usr/bin/env node

import os from "os";
import fs from "fs";
import { exec } from "child_process";
import util from "util";
import readline from "readline";

const execAsync = util.promisify(exec);

const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const res  = (id, result) => send({ jsonrpc: "2.0", id, result });

function ok(data)    { return { success: true,  content: data }; }
function err(msg)    { return { success: false, content: msg }; }
function text(obj)   { return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] }; }

async function run(cmd) {
    try {
        const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 20 });
        return { success: true, content: { stdout: stdout?.trim(), stderr: stderr?.trim() || "" } };
    } catch (e) {
        return { success: false, content: { stdout: e.stdout?.trim() || "", stderr: e.stderr?.trim() || e.message } };
    }
}

// --- Business logic ---

async function systemInfo() {
    try {
        const distro = fs.readFileSync("/etc/os-release", "utf8")
            .split("\n")
            .find(l => l.startsWith("PRETTY_NAME="))
            ?.split("=")[1]
            ?.replace(/"/g, "");

        const virt = await run("systemd-detect-virt");
        const disk = await run("df -h / --output=size,used,avail,pcent | tail -1");
        const parts = disk.content.stdout?.split(/\s+/) || [];

        return ok({
            hostname: os.hostname(),
            distro: distro || "unknown",
            kernel: os.release(),
            uptime: os.uptime(),
            cpu: { model: os.cpus()?.[0]?.model, cores: os.cpus().length },
            memory: { total: os.totalmem(), free: os.freemem() },
            disk: { raw: parts },
            virtualization: virt.content.stdout || "none",
            container: fs.existsSync("/.dockerenv")
        });
    } catch (e) {
        return err(e.message);
    }
}

async function systemMetrics() {
    try {
        const load = os.loadavg();
        const net  = await run("ip -json addr");
        return ok({
            cpu: { load_1m: load[0], load_5m: load[1], load_15m: load[2] },
            memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem() },
            network: net.success ? JSON.parse(net.content.stdout || "[]") : []
        });
    } catch (e) {
        return err(e.message);
    }
}

async function systemProcesses(args) {
    try {
        const sort   = args?.sort   || "%cpu";
        const limit  = args?.limit  || 20;
        const search = args?.search;

        const r = await run(`ps -eo pid,user,%cpu,%mem,etime,state,comm,args --sort=-${sort}`);
        if (!r.success) return r;

        let parsed = r.content.stdout.split("\n").slice(1).map(l => {
            const p = l.trim().split(/\s+/, 8);
            return { pid: +p[0], user: p[1], cpu: +p[2], mem: +p[3], time: p[4], state: p[5], command: p[6], args: p[7] };
        });

        if (search) parsed = parsed.filter(x => JSON.stringify(x).toLowerCase().includes(search.toLowerCase()));
        return ok(parsed.slice(0, limit));
    } catch (e) {
        return err(e.message);
    }
}

async function systemServices(args) {
    try {
        if (args?.action && args?.unit) {
            const allowed = ["start", "stop", "restart", "enable", "disable"];
            if (!allowed.includes(args.action)) return err("invalid action");
            return await run(`sudo systemctl ${args.action} ${args.unit}`);
        }

        const r = await run("systemctl list-units --type=service --all --no-pager --plain --no-legend");
        if (!r.success) return r;

        const services = r.content.stdout.split("\n").filter(Boolean).map(l => {
            const p = l.trim().split(/\s+/, 5);
            return { unit: p[0], load: p[1], active: p[2], sub: p[3], desc: p[4] };
        });
        return ok(services);
    } catch (e) {
        return err(e.message);
    }
}

async function systemLogs(args) {
    try {
        let cmd = "journalctl --output=json";
        if (args?.unit)     cmd += ` -u ${args.unit}`;
        if (args?.priority) cmd += ` -p ${args.priority}`;
        if (args?.since)    cmd += ` --since "${args.since}"`;
        if (args?.lines)    cmd += ` -n ${args.lines}`;
        if (args?.follow)   cmd += " -f";

        const r = await run(cmd);
        if (!r.success) return r;

        const logs = r.content.stdout.split("\n").filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
        return ok(logs);
    } catch (e) {
        return err(e.message);
    }
}

// --- Tools ---

const TOOLS = {
    "system.info": {
        description: "Get system information (hostname, distro, kernel, CPU, memory, disk, virtualization)",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: () => systemInfo()
    },
    "system.metrics": {
        description: "Get live system metrics (CPU load, memory, network interfaces)",
        inputSchema: { type: "object", properties: {}, required: [] },
        handler: () => systemMetrics()
    },
    "system.processes": {
        description: "List running processes with optional filtering and sorting",
        inputSchema: {
            type: "object",
            properties: {
                search: { type: "string" },
                sort:   { type: "string" },
                limit:  { type: "number" }
            },
            required: []
        },
        handler: args => systemProcesses(args)
    },
    "system.services": {
        description: "List systemd services or manage a unit (start/stop/restart/enable/disable)",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string" },
                unit:   { type: "string" }
            },
            required: []
        },
        handler: args => systemServices(args)
    },
    "system.logs": {
        description: "Read journald logs with optional filters",
        inputSchema: {
            type: "object",
            properties: {
                unit:     { type: "string" },
                priority: { type: "string" },
                since:    { type: "string" },
                lines:    { type: "number" },
                follow:   { type: "boolean" }
            },
            required: []
        },
        handler: args => systemLogs(args)
    }
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
            serverInfo: { name: "linux-sysadmin-mcp", version: "1.1.0" },
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
        if (!tool) return res(id, text(err("unknown tool")));
        try {
            return res(id, text(await tool.handler(args)));
        } catch (e) {
            return res(id, text(err(e.message)));
        }
    }

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});