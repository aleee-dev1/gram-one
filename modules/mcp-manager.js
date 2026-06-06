import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.join(__dirname, "../mcp/servers");

export const clients = {};

export async function initMcp() {
    try {
        const files = await fs.readdir(mcpDir);
        for (const file of files) {
            console.log('Loading', file);
            if (file.endsWith(".js")) {
                const transport = new StdioClientTransport({
                    command: "node",
                    args: [path.join(mcpDir, file)],
                    env: { ...process.env}
                });
                const client = new Client(
                    { name: "gram-one", version: "1.0.0" },
                    { capabilities: {} }
                );
                await client.connect(transport);
                const serverName = file.replace(".js", "");
                clients[serverName] = client;
                console.log(`Loaded MCP server: ${file}`);
            }
        }
    } catch (err) {
        console.error("Error loading MCP servers:", err);
    }
}

export async function getMcpServers() {
    return Object.keys(clients).map(id => ({
        id,
        name: id.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
    }));
}

export async function getTools(allowedServers = null) {
    const allTools = [];
    for (const [serverName, client] of Object.entries(clients)) {
        if (allowedServers && !allowedServers.includes(serverName)) continue;
        try {
            const res = await client.listTools();
            for (const tool of res.tools) {
                allTools.push({
                    type: "function",
                    function: {
                        name: `${serverName}__${tool.name}`,
                        description: tool.description,
                        parameters: tool.inputSchema || { type: "object", properties: {} }
                    }
                });
            }
        } catch (err) {
            console.error(`Failed to get tools for ${serverName}:`, err);
        }
    }
    return allTools;
}

export async function executeTool(serverName, toolName, args) {
    const client = clients[serverName];
    if (!client) throw new Error(`Server ${serverName} not found`);
    const res = await client.callTool({ name: toolName, arguments: args });
    return res;
}
