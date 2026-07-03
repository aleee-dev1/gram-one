import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    getMcpServerMeta,
    updateMcpServerMeta,
    clearMcpTools,
    saveMcpTool,
    getEnabledMcpServers
} from "./db.js";
import { embedText } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.join(__dirname, "../mcp");

export const clients = {};

const externalMcps = [
    {
        name: "playwright",
        command: "npx",
        args: ["@playwright/mcp@latest"]
    },

];

async function loadServer(name, command, args) {
    const transport = new StdioClientTransport({
        command,
        args,
        env: { ...process.env }
    });

    const client = new Client(
        { name: "gram-one", version: "1.0.0" },
        { capabilities: {} }
    );

    await client.connect(transport);

    clients[name] = client;

    console.log(`Loaded MCP server: ${name}`);

    return client;
}

async function indexTools(serverName, client, hash) {
    const meta = await getMcpServerMeta(serverName);

    if (meta && meta.shasum === hash) return;

    console.log(`Updating tools for ${serverName}`);

    await clearMcpTools(serverName);

    const res = await client.listTools();

    for (const tool of res.tools) {
        const details = `${tool.name}: ${tool.description}`;
        const embedding = await embedText(details);

        await saveMcpTool(
            serverName,
            tool.name,
            tool.description,
            tool.inputSchema || {
                type: "object",
                properties: {}
            },
            embedding
        );
    }

    await updateMcpServerMeta(serverName, hash);
}

export async function initMcp() {
    try {
        const categories = ["extended", "legacy"];

        for (const category of categories) {
            const categoryDir = path.join(mcpDir, category);

            let files = [];

            try {
                files = await fs.readdir(categoryDir);
            } catch (err) {
                if (err.code !== "ENOENT") throw err;
                continue;
            }

            for (const file of files) {
                if (!file.endsWith(".js")) continue;

                console.log(`Loading ${category}/${file}`);

                const serverPath = path.join(categoryDir, file);
                const serverName = file.replace(".js", "");

                const client = await loadServer(
                    serverName,
                    "node",
                    [serverPath]
                );

                const content = await fs.readFile(serverPath, "utf8");

                const hash = crypto
                    .createHash("sha256")
                    .update(content)
                    .digest("hex");

                await indexTools(serverName, client, hash);
            }
        }

        // Load external MCPs
        for (const server of externalMcps) {
            console.log(`Loading external MCP: ${server.name}`);

            const client = await loadServer(
                server.name,
                server.command,
                server.args
            );

            const hash = crypto
                .createHash("sha256")
                .update(JSON.stringify(server))
                .digest("hex");

            await indexTools(server.name, client, hash);
        }
    } catch (err) {
        console.error("Error loading MCP servers:", err);
    }
}

export async function getMcpServers() {
    const enabledServers = await getEnabledMcpServers();
    return Object.keys(clients).map(id => ({
        id,
        name: id
            .split("-")
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" "),
        enabled: enabledServers.includes(id)
    }));
}

export async function getTools(allowedServers = null) {
    const allTools = [];

    for (const [serverName, client] of Object.entries(clients)) {
        if (allowedServers && !allowedServers.includes(serverName))
            continue;

        try {
            const res = await client.listTools();

            for (const tool of res.tools) {
                allTools.push({
                    type: "function",
                    function: {
                        name: `${serverName}__${tool.name}`,
                        description: tool.description,
                        parameters:
                            tool.inputSchema || {
                                type: "object",
                                properties: {}
                            }
                    }
                });
            }
        } catch (err) {
            console.error(
                `Failed to get tools for ${serverName}:`,
                err
            );
        }
    }

    return allTools;
}

export async function executeTool(serverName, toolName, args) {
    const client = clients[serverName];

    if (!client)
        throw new Error(`Server ${serverName} not found`);

    return client.callTool({
        name: toolName,
        arguments: args
    });
}