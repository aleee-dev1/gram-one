import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { exec } from "child_process";

const server = new Server(
    {
        name: "shell-mcp",
        version: "1.0.0"
    },
    {
        capabilities: {
            tools: {}
        }
    }
);

// list tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "run",
                description: "Run shell command",
                inputSchema: {
                    type: "object",
                    properties: {
                        cmd: { type: "string" }
                    },
                    required: ["cmd"]
                }
            }
        ]
    };
});

// call tool
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "run") {
        throw new Error("Unknown tool");
    }

    const { cmd } = req.params.arguments;

    return new Promise((resolve) => {
        exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
            let result = { success: true, content: 'Command executed successfully' };
            if (err) {
                result = { success: false, content: err.message };
            }
            if (stderr) {
                result = { success: false, content: stderr };
            }
            if (stdout) {
                result = { success: true, content: stdout };
            }
            resolve({
                content: [{
                    type: "text",
                    text: JSON.stringify(result)
                }]
            });
        });
    });
});

const transport = new StdioServerTransport();
await server.connect(transport);