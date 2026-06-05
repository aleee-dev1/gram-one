// networking-mcp.js
// npm i @modelcontextprotocol/sdk zod
// Linux-focused MCP networking server

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import os from "os";
import fs from "fs/promises";
import dns from "dns/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import https from "https";

const exec = promisify(execFile);

const server = new McpServer({
    name: "networking-mcp",
    version: "1.1.0",
});

// --- HELPER FUNCTIONS ---

function ok(content) {
    return { success: true, content };
}

function fail(err) {
    return { success: false, content: { error: err?.message || String(err) } };
}

async function run(cmd, args = []) {
    const { stdout, stderr } = await exec(cmd, args, {
        maxBuffer: 1024 * 1024 * 20,
    });
    return {
        stdout: stdout?.trim(),
        stderr: stderr?.trim(),
    };
}

function safeJsonParse(v, fallback = null) {
    try {
        return JSON.parse(v);
    } catch {
        return fallback;
    }
}

/**
 * Shared logic for parsing 'ss' command output
 */
function parseSsOutput(raw) {
    const lines = raw.split("\n").filter(line => line.trim() && !line.startsWith("Netid"));
    return lines.map(line => {
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

        let processName = null;
        let pid = null;
        if (processRaw) {
            const nameMatch = processRaw.match(/"([^"]+)"/);
            const pidMatch = processRaw.match(/pid=(\d+)/);
            processName = nameMatch ? nameMatch[1] : null;
            pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
        }

        return {
            protocol,
            state,
            local_address: localAddr,
            port: localPort,
            process: processName,
            pid: pid,
            peer: (peer === "*:*" || peer === "0.0.0.0:*") ? "any" : peer
        };
    });
}

/**
 * Filter results for connections and ports
 */
function filterNetworkResults(data, args) {
    return data.filter(item => {
        if (args.protocol && item.protocol !== args.protocol.toLowerCase()) return false;
        if (args.state && item.state?.toLowerCase() !== args.state.toLowerCase()) return false;
        if (args.address && !item.local_address.includes(args.address)) return false;
        if (args.port && item.port !== args.port) return false;
        if (args.process && (!item.process || !item.process.toLowerCase().includes(args.process.toLowerCase()))) return false;
        if (args.pid && item.pid !== args.pid) return false;
        return true;
    });
}

const NetworkFilterSchema = {
    protocol: z.string().optional().describe("Filter by protocol (tcp, udp)"),
    state: z.string().optional().describe("Filter by state (LISTEN, ESTAB, etc)"),
    address: z.string().optional().describe("Filter by local address"),
    port: z.number().optional().describe("Filter by local port number"),
    process: z.string().optional().describe("Filter by process name"),
    pid: z.number().optional().describe("Filter by process ID"),
};

// --- TOOLS ---

// net.interfaces
server.tool("net.interfaces", {}, async () => {
    try {
        const interfaces = os.networkInterfaces();
        const result = Object.entries(interfaces).map(([name, infos]) => ({
            name,
            addresses: (infos || []).map((i) => ({
                family: i.family,
                address: i.address,
                mac: i.mac,
                internal: i.internal,
                cidr: i.cidr,
            })),
        }));
        return { content: [{ type: "text", text: JSON.stringify(ok(result), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.ip
server.tool("net.ip", { type: z.enum(["lan", "public"]) }, async ({ type }) => {
    try {
        if (type === "public") {
            const ip = await new Promise((resolve, reject) => {
                https.get("https://api.ipify.org?format=json", (res) => {
                    let data = "";
                    res.on("data", (c) => (data += c));
                    res.on("end", () => resolve(JSON.parse(data).ip));
                }).on("error", reject);
            });
            return { content: [{ type: "text", text: JSON.stringify(ok({ public_ip: ip }), null, 2) }] };
        }
        const interfaces = os.networkInterfaces();
        const ips = [];
        for (const [name, infos] of Object.entries(interfaces)) {
            for (const i of infos || []) {
                if (!i.internal) ips.push({ interface: name, family: i.family, ip: i.address });
            }
        }
        return { content: [{ type: "text", text: JSON.stringify(ok({ lan_ips: ips }), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.routes
server.tool("net.routes", {}, async () => {
    try {
        const { stdout } = await run("ip", ["-j", "route"]);
        return { content: [{ type: "text", text: JSON.stringify(ok(safeJsonParse(stdout, [])), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.dns
server.tool("net.dns", {}, async () => {
    try {
        const resolv = await fs.readFile("/etc/resolv.conf", "utf8");
        const servers = resolv.split("\n")
            .filter((l) => l.startsWith("nameserver"))
            .map((l) => l.split(/\s+/)[1]);
        return { content: [{ type: "text", text: JSON.stringify(ok({ nameservers: servers }), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.connections
server.tool("net.connections", NetworkFilterSchema, async (args) => {
    try {
        const { stdout } = await run("ss", ["-tunap"]);
        const filtered = filterNetworkResults(parseSsOutput(stdout), args);
        return { content: [{ type: "text", text: JSON.stringify(ok(filtered), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.open_ports
server.tool("net.open_ports", NetworkFilterSchema, async (args) => {
    try {
        const { stdout } = await run("ss", ["-ltnup"]);
        const open = parseSsOutput(stdout).filter(p => p.state === "LISTEN" || p.protocol === "udp");
        const filtered = filterNetworkResults(open, args);
        return { content: [{ type: "text", text: JSON.stringify(ok(filtered), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.ping
server.tool("net.ping", { host: z.string(), count: z.number().default(4) }, async ({ host, count }) => {
    try {
        const { stdout } = await run("ping", ["-c", String(count), host]);
        return { content: [{ type: "text", text: JSON.stringify(ok({ host, result: stdout }), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.traceroute
server.tool("net.traceroute", { host: z.string() }, async ({ host }) => {
    try {
        const bin = await fs.access("/usr/bin/traceroute").then(() => "traceroute").catch(() => "tracepath");
        const { stdout } = await run(bin, [host]);

        const lines = stdout.split("\n").filter(l => l.trim() && !l.toLowerCase().startsWith("traceroute") && !l.toLowerCase().startsWith("tracepath"));
        const hops = lines.map(line => {
            const hopMatch = line.match(/^\s*(\d+)\s+(.*)$/);
            if (!hopMatch) return null;

            const hop = Number(hopMatch[1]);
            const content = hopMatch[2].trim();

            if (content === "* * *" || content === "???" || /^\*\s+\*\s+\*$/.test(content)) {
                return { hop, timeout: true };
            }

            const nodes = [];

            const regex = /(?:(\S+)\s+\((\d{1,3}(?:\.\d{1,3}){3})\)|(\d{1,3}(?:\.\d{1,3}){3}))\s+(\d+(?:\.\d+)?)\s+ms/g;
            let match;

            while ((match = regex.exec(content)) !== null) {
                const hostname = match[1] || null;
                const ip = match[2] || match[3];
                const latency = Number(match[4]);
                // nodes.push(`${hostname} (${ip}) ${latency}ms`)
                nodes.push({hostname, ip, latency})
            }

            return { hop, nodes, partial_timeout: content.includes("*") };
        }).filter(Boolean).filter(h => !h.timeout);

        return { content: [{ type: "text", text: JSON.stringify(ok({ host, hops }), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.nslookup
server.tool("net.nslookup", { host: z.string() }, async ({ host }) => {
    try {
        const result = await dns.lookup(host, { all: true });
        return { content: [{ type: "text", text: JSON.stringify(ok({ host, records: result }), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.wifi.scan
server.tool("net.wifi.scan", { interface: z.string(), timeout: z.number().default(10) }, async ({ interface: iface, timeout }) => {
    try {
        await run("timeout", [String(timeout), "nmcli", "dev", "wifi", "rescan", "ifname", iface]).catch(() => { });
        const { stdout } = await run("nmcli", ["-t", "-f", "SSID,BSSID,CHAN,SIGNAL,SECURITY", "dev", "wifi", "list", "ifname", iface]);
        const networks = stdout.split("\n").filter(Boolean).map((line) => {
            const parts = line.split(/(?<!\\):/);
            const unescape = (val) => val ? val.replace(/\\:/g, ':') : null;
            return {
                ssid: unescape(parts[0]),
                bssid: unescape(parts[1]),
                channel: parts[2] ? Number(parts[2]) : null,
                signal: parts[3] ? Number(parts[3]) : null,
                security: unescape(parts[4]),
            };
        });
        return { content: [{ type: "text", text: JSON.stringify(ok(networks), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.curl
server.tool("net.curl", { url: z.string(), method: z.string().default("GET") }, async ({ url, method }) => {
    try {
        const { stdout } = await run("curl", ["-s", "-L", "-X", method.toUpperCase(), url]);
        return { content: [{ type: "text", text: JSON.stringify(ok({ url, response: stdout }), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.speedtest
server.tool("net.speedtest", { url: z.string().optional() }, async ({ url = "https://speed.cloudflare.com/__down?bytes=10485760" }) => {
    try {
        const { stdout } = await run("curl", ["-L", "-s", "-w", "%{size_download}|%{time_total}|%{speed_download}", "-o", "/dev/null", url]);
        const [bytes, seconds, speed] = stdout.split("|").map(Number);
        return {
            content: [{
                type: "text",
                text: JSON.stringify(ok({
                    url,
                    bytes_downloaded: bytes,
                    duration_seconds: Number(seconds.toFixed(2)),
                    speed_mbps: Number(((speed * 8) / 1024 / 1024).toFixed(2)),
                }), null, 2)
            }]
        };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.wifi.connect
server.tool("net.wifi.connect", { ssid: z.string(), password: z.string() }, async ({ ssid, password }) => {
    try {
        const { stdout } = await run("nmcli", ["dev", "wifi", "connect", ssid, "password", password]);
        return { content: [{ type: "text", text: JSON.stringify(ok({ result: stdout }), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

// net.firewall
server.tool("net.firewall", {}, async () => {
    try {
        let result = {};
        try { result.ufw = (await run("ufw", ["status", "verbose"])).stdout; } catch { }
        try { result.iptables = (await run("iptables", ["-L", "-n", "-v"])).stdout; } catch { }
        try { result.nftables = (await run("nft", ["list", "ruleset"])).stdout; } catch { }
        return { content: [{ type: "text", text: JSON.stringify(ok(result), null, 2) }] };
    } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify(fail(e), null, 2) }] };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);