import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { searchKeywords, scrape } from "../helpers/web-helper.js";

const server = new Server(
    { name: "web-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "search",
            description: "Search internet for webpages",
            inputSchema: {
                type: "object",
                properties: {
                    keywords: { type: "string" },
                    maxResults: {
                        type: "number",
                        minimum: 1,
                        maximum: 10
                    }
                },
                required: ["keywords"]
            }
        },
        {
            name: "scrape",
            description: "Extract readable content from a URL",
            inputSchema: {
                type: "object",
                properties: {
                    url: { type: "string" }
                },
                required: ["url"]
            }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
        if (name === "search") {
            const content = await searchKeywords(
                args.keywords,
                args.maxResults ?? 5
            );

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            success: true,
                            content
                        })
                    }
                ]
            };
        }

        if (name === "scrape") {
            const content = await scrape(args.url);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            success: true,
                            content
                        })
                    }
                ]
            };
        }

        throw new Error("Unknown tool");
    } catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        err: err.message
                    })
                }
            ]
        };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);