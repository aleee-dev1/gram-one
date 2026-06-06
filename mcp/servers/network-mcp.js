#!/usr/bin/env node

import os from "os";
import fs from "fs/promises";
import dns from "dns/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import https from "https";
import readline from "readline";

const exec = promisify(execFile);

// --- HELPERS ---

const ok  = content => ({ success: true, content });
const fail = err => ({ success: false, content: { error: err?.message || String(err) } });
const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const res  = (id, result) => send({ jsonrpc: "2.0", id, result });
const errRes = (id, msg) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ success: false, content: msg }) }] } });

async function run(cmd, args = []) {
    const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 1024 * 1024 * 20 });
    return { stdout: stdout?.trim(), stderr: stderr?.trim() };
}

function safeJsonParse(v, fallback = null) {
    try { return JSON.parse(v); } catch { return fallback; }
}

function parseSsOutput(raw) {
    return raw.split("\n").filter(l => l.trim() && !l.startsWith("Netid")).map(line => {
        const parts = line.split(/\s+/);
        const protocol = parts[0]?.toLowerCase();
        const state = parts[1];
        const local = parts[4] || "";
        const peer = parts[5] || "";
        const processRaw = parts.slice(6).join(" ");

        const localPortIndex = local.lastIndexOf(":");
        const localAddr = local.substring(0, localPortIndex);
        const localPortStr = local.substring(localPortIndex + 1);
        const localPort = localPortStr === "*" ? null : parseInt(localPortStr, 10);

        let processName = null, pid = null;
        if (processRaw) {
            const nameMatch = processRaw.match(/"([^"]+)"/);
            const pidMatch  = processRaw.match(/pid=(\d+)/);
            processName = nameMatch ? nameMatch[1] : null;
            pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
        }

        return {
            protocol, state,
            local_address: localAddr,
            port: localPort,
            process: processName,
            pid,
            peer: (peer === "*:*" || peer === "0.0.0.0:*") ? "any" : peer
        };
    });
}

function filterNetworkResults(data, args) {
    return data.filter(item => {
        if (args.protocol && item.protocol !== args.protocol.toLowerCase()) return false;
        if (args.state   && item.state?.toLowerCase() !== args.state.toLowerCase()) return false;
        if (args.address && !item.local_address.includes(args.address)) return false;
        if (args.port    && item.port !== args.port) return false;
        if (args.process && (!item.process || !item.process.toLowerCase().includes(args.process.toLowerCase()))) return false;
        if (args.pid     && item.pid !== args.pid) return false;
        return true;
    });
}

const NetworkFilterSchema = {
    type: "object",
    properties: {
        protocol: { type: "string", description: "Filter by protocol (tcp, udp)" },
        state:    { type: "string", description: "Filter by state (LISTEN, ESTAB, etc)" },
        address:  { type: "string", description: "Filter by local address" },
        port:     { type: "number", description: "Filter by local port number" },
        process:  { type: "string", description: "Filter by process name" },
        pid:      { type: "number", description: "Filter by process ID" },
    },
    required: []
};

// --- TOOLS ---

const TOOLS = {
    "net.interfaces": {
        description: "List all network interfaces and their addresses",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const interfaces = os.networkInterfaces();
            const result = Object.entries(interfaces).map(([name, infos]) => ({
                name,
                addresses: (infos || []).map(i => ({
                    family: i.family, address: i.address,
                    mac: i.mac, internal: i.internal, cidr: i.cidr,
                })),
            }));
            return ok(result);
        }
    },

    "net.ip": {
        description: "Get LAN or public IP address",
        inputSchema: {
            type: "object",
            properties: { type: { type: "string", enum: ["lan", "public"] } },
            required: ["type"]
        },
        async handler({ type }) {
            if (type === "public") {
                const ip = await new Promise((resolve, reject) => {
                    https.get("https://api.ipify.org?format=json", res => {
                        let data = "";
                        res.on("data", c => data += c);
                        res.on("end", () => resolve(JSON.parse(data).ip));
                    }).on("error", reject);
                });
                return ok({ public_ip: ip });
            }
            const interfaces = os.networkInterfaces();
            const ips = [];
            for (const [name, infos] of Object.entries(interfaces))
                for (const i of infos || [])
                    if (!i.internal) ips.push({ interface: name, family: i.family, ip: i.address });
            return ok({ lan_ips: ips });
        }
    },

    "net.routes": {
        description: "Show current routing table",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const { stdout } = await run("ip", ["-j", "route"]);
            return ok(safeJsonParse(stdout, []));
        }
    },

    "net.dns": {
        description: "Show configured DNS nameservers from /etc/resolv.conf",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const resolv = await fs.readFile("/etc/resolv.conf", "utf8");
            const servers = resolv.split("\n")
                .filter(l => l.startsWith("nameserver"))
                .map(l => l.split(/\s+/)[1]);
            return ok({ nameservers: servers });
        }
    },

    "net.connections": {
        description: "List active network connections with optional filters",
        inputSchema: NetworkFilterSchema,
        async handler(args) {
            const { stdout } = await run("ss", ["-tunap"]);
            return ok(filterNetworkResults(parseSsOutput(stdout), args));
        }
    },

    "net.open_ports": {
        description: "List open/listening ports with optional filters",
        inputSchema: NetworkFilterSchema,
        async handler(args) {
            const { stdout } = await run("ss", ["-ltnup"]);
            const open = parseSsOutput(stdout).filter(p => p.state === "LISTEN" || p.protocol === "udp");
            return ok(filterNetworkResults(open, args));
        }
    },

    "net.ping": {
        description: "Ping a host",
        inputSchema: {
            type: "object",
            properties: {
                host:  { type: "string" },
                count: { type: "number", default: 4 }
            },
            required: ["host"]
        },
        async handler({ host, count = 4 }) {
            const { stdout } = await run("ping", ["-c", String(count), host]);
            return ok({ host, result: stdout });
        }
    },

    "net.traceroute": {
        description: "Traceroute to a host",
        inputSchema: {
            type: "object",
            properties: { host: { type: "string" } },
            required: ["host"]
        },
        async handler({ host }) {
            const bin = await fs.access("/usr/bin/traceroute").then(() => "traceroute").catch(() => "tracepath");
            const { stdout } = await run(bin, [host]);
            const lines = stdout.split("\n").filter(l => l.trim() && !l.toLowerCase().startsWith("traceroute") && !l.toLowerCase().startsWith("tracepath"));
            const hops = lines.map(line => {
                const hopMatch = line.match(/^\s*(\d+)\s+(.*)$/);
                if (!hopMatch) return null;
                const hop = Number(hopMatch[1]);
                const content = hopMatch[2].trim();
                if (content === "* * *" || content === "???" || /^\*\s+\*\s+\*$/.test(content))
                    return { hop, timeout: true };
                const nodes = [];
                const regex = /(?:(\S+)\s+\((\d{1,3}(?:\.\d{1,3}){3})\)|(\d{1,3}(?:\.\d{1,3}){3}))\s+(\d+(?:\.\d+)?)\s+ms/g;
                let match;
                while ((match = regex.exec(content)) !== null)
                    nodes.push({ hostname: match[1] || null, ip: match[2] || match[3], latency: Number(match[4]) });
                return { hop, nodes, partial_timeout: content.includes("*") };
            }).filter(Boolean).filter(h => !h.timeout);
            return ok({ host, hops });
        }
    },

    "net.nslookup": {
        description: "DNS lookup for a host",
        inputSchema: {
            type: "object",
            properties: { host: { type: "string" } },
            required: ["host"]
        },
        async handler({ host }) {
            const result = await dns.lookup(host, { all: true });
            return ok({ host, records: result });
        }
    },

    "net.wifi.scan": {
        description: "Scan for nearby WiFi networks on a given interface",
        inputSchema: {
            type: "object",
            properties: {
                interface: { type: "string" },
                timeout:   { type: "number", default: 10 }
            },
            required: ["interface"]
        },
        async handler({ interface: iface, timeout = 10 }) {
            await run("timeout", [String(timeout), "nmcli", "dev", "wifi", "rescan", "ifname", iface]).catch(() => {});
            const { stdout } = await run("nmcli", ["-t", "-f", "SSID,BSSID,CHAN,SIGNAL,SECURITY", "dev", "wifi", "list", "ifname", iface]);
            const unescape = val => val ? val.replace(/\\:/g, ":") : null;
            const networks = stdout.split("\n").filter(Boolean).map(line => {
                const parts = line.split(/(?<!\\):/);
                return {
                    ssid:     unescape(parts[0]),
                    bssid:    unescape(parts[1]),
                    channel:  parts[2] ? Number(parts[2]) : null,
                    signal:   parts[3] ? Number(parts[3]) : null,
                    security: unescape(parts[4]),
                };
            });
            return ok(networks);
        }
    },

    "net.curl": {
        description: "HTTP request via curl",
        inputSchema: {
            type: "object",
            properties: {
                url:    { type: "string" },
                method: { type: "string", default: "GET" }
            },
            required: ["url"]
        },
        async handler({ url, method = "GET" }) {
            const { stdout } = await run("curl", ["-s", "-L", "-X", method.toUpperCase(), url]);
            return ok({ url, response: stdout });
        }
    },

    "net.speedtest": {
        description: "Download speed test",
        inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
            required: []
        },
        async handler({ url = "https://speed.cloudflare.com/__down?bytes=10485760" }) {
            const { stdout } = await run("curl", ["-L", "-s", "-w", "%{size_download}|%{time_total}|%{speed_download}", "-o", "/dev/null", url]);
            const [bytes, seconds, speed] = stdout.split("|").map(Number);
            return ok({
                url,
                bytes_downloaded: bytes,
                duration_seconds: Number(seconds.toFixed(2)),
                speed_mbps: Number(((speed * 8) / 1024 / 1024).toFixed(2)),
            });
        }
    },

    "net.wifi.connect": {
        description: "Connect to a WiFi network",
        inputSchema: {
            type: "object",
            properties: {
                ssid:     { type: "string" },
                password: { type: "string" }
            },
            required: ["ssid", "password"]
        },
        async handler({ ssid, password }) {
            const { stdout } = await run("nmcli", ["dev", "wifi", "connect", ssid, "password", password]);
            return ok({ result: stdout });
        }
    },

    "net.firewall": {
        description: "Show firewall rules (ufw, iptables, nftables)",
        inputSchema: { type: "object", properties: {}, required: [] },
        async handler() {
            const result = {};
            try { result.ufw      = (await run("ufw",      ["status", "verbose"])).stdout; } catch {}
            try { result.iptables = (await run("iptables", ["-L", "-n", "-v"])).stdout;    } catch {}
            try { result.nftables = (await run("nft",      ["list", "ruleset"])).stdout;   } catch {}
            return ok(result);
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
            serverInfo: { name: "networking-mcp", version: "1.1.0" },
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
        if (!tool) return errRes(id, `Unknown tool: ${name}`);
        try {
            const result = await tool.handler(args);
            return res(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
            return res(id, { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] });
        }
    }

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});