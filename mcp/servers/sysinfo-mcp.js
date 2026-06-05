#!/usr/bin/env node

import os from "os";
import fs from "fs";
import { exec } from "child_process";
import util from "util";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const execAsync = util.promisify(exec);

const server = new Server(
    {
        name: "linux-sysadmin-mcp",
        version: "1.1.0"
    },
    {
        capabilities: { tools: {} }
    }
);

async function run(cmd) {
    try {
        const { stdout, stderr } = await execAsync(cmd, {
            maxBuffer: 1024 * 1024 * 20
        });

        return {
            success: true,
            content: {
                stdout: stdout?.trim(),
                stderr: stderr?.trim() || ""
            }
        };
    } catch (e) {
        return {
            success: false,
            content: {
                stdout: e.stdout?.trim() || "",
                stderr: e.stderr?.trim() || e.message
            }
        };
    }
}

function ok(data) {
    return {
        success: true,
        content: data
    };
}

function err(message) {
    return {
        success: false,
        content: message
    };
}

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
            cpu: {
                model: os.cpus()?.[0]?.model,
                cores: os.cpus().length
            },
            memory: {
                total: os.totalmem(),
                free: os.freemem()
            },
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

        const net = await run("ip -json addr");

        return ok({
            cpu: {
                load_1m: load[0],
                load_5m: load[1],
                load_15m: load[2]
            },
            memory: {
                total: os.totalmem(),
                free: os.freemem(),
                used: os.totalmem() - os.freemem()
            },
            network: net.success ? JSON.parse(net.content.stdout || "[]") : []
        });
    } catch (e) {
        return err(e.message);
    }
}

async function systemProcesses(args) {
    try {
        const sort = args?.sort || "%cpu";
        const limit = args?.limit || 20;
        const search = args?.search;

        const res = await run(`ps -eo pid,user,%cpu,%mem,etime,state,comm,args --sort=-${sort}`);

        if (!res.success) return res;

        let lines = res.content.stdout.split("\n").slice(1);

        let parsed = lines.map(l => {
            const p = l.trim().split(/\s+/, 8);
            return {
                pid: +p[0],
                user: p[1],
                cpu: +p[2],
                mem: +p[3],
                time: p[4],
                state: p[5],
                command: p[6],
                args: p[7]
            };
        });

        if (search) {
            parsed = parsed.filter(x => JSON.stringify(x).toLowerCase().includes(search.toLowerCase()));
        }

        return ok(parsed.slice(0, limit));
    } catch (e) {
        return err(e.message);
    }
}

async function systemServices(args) {
    try {
        if (args?.action && args?.unit) {
            const allowed = ["start", "stop", "restart", "enable", "disable"];
            if (!allowed.includes(args.action)) {
                return err("invalid action");
            }

            return await run(`sudo systemctl ${args.action} ${args.unit}`);
        }

        const res = await run("systemctl list-units --type=service --all --no-pager --plain --no-legend");

        if (!res.success) return res;

        const services = res.content.stdout
            .split("\n")
            .filter(Boolean)
            .map(l => {
                const p = l.trim().split(/\s+/, 5);
                return {
                    unit: p[0],
                    load: p[1],
                    active: p[2],
                    sub: p[3],
                    desc: p[4]
                };
            });

        return ok(services);
    } catch (e) {
        return err(e.message);
    }
}

async function systemLogs(args) {
    try {
        let cmd = "journalctl --output=json";

        if (args?.unit) cmd += ` -u ${args.unit}`;
        if (args?.priority) cmd += ` -p ${args.priority}`;
        if (args?.since) cmd += ` --since "${args.since}"`;
        if (args?.lines) cmd += ` -n ${args.lines}`;
        if (args?.follow) cmd += " -f";

        const res = await run(cmd);

        if (!res.success) return res;

        const logs = res.content.stdout.split("\n")
            .filter(Boolean)
            .map(l => {
                try { return JSON.parse(l); } 
                catch { return null; }
            })
            .filter(Boolean);

        return ok(logs);
    } catch (e) {
        return err(e.message);
    }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        { name: "system.info", inputSchema: { type: "object" } },
        { name: "system.metrics", inputSchema: { type: "object" } },
        {
            name: "system.processes",
            inputSchema: {
                type: "object",
                properties: {
                    search: { type: "string" },
                    sort: { type: "string" },
                    limit: { type: "number" }
                }
            }
        },
        {
            name: "system.services",
            inputSchema: {
                type: "object",
                properties: {
                    action: { type: "string" },
                    unit: { type: "string" }
                }
            }
        },
        {
            name: "system.logs",
            inputSchema: {
                type: "object",
                properties: {
                    unit: { type: "string" },
                    priority: { type: "string" },
                    since: { type: "string" },
                    lines: { type: "number" },
                    follow: { type: "boolean" }
                }
            }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    let result;

    switch (name) {
        case "system.info":
            result = await systemInfo();
            break;
        case "system.metrics":
            result = await systemMetrics();
            break;
        case "system.processes":
            result = await systemProcesses(args);
            break;
        case "system.services":
            result = await systemServices(args);
            break;
        case "system.logs":
            result = await systemLogs(args);
            break;
        default:
            result = err("unknown tool");
    }

    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(result, null, 2)
            }
        ]
    };
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);