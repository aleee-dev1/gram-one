import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import { initDb, database } from "../helpers/db-helper.js";

await initDb();

const server = new Server(
    { name: "db-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            // --- Table management ---
            {
                name: "create_table",
                description: "Create a new table using a sample object to infer schema",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        sampleObject: { type: "object" }
                    },
                    required: ["name", "sampleObject"]
                }
            },
            {
                name: "remove_table",
                description: "Drop a table and its schema entry",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string" }
                    },
                    required: ["name"]
                }
            },
            {
                name: "clear_table",
                description: "Delete all rows from a table and reset autoincrement",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string" }
                    },
                    required: ["name"]
                }
            },
            {
                name: "get_all_tables",
                description: "List all user-created tables",
                inputSchema: { type: "object", properties: {} }
            },

            // --- Row operations ---
            {
                name: "get_all_items",
                description: "Get all rows from a table, or specific rows by id array",
                inputSchema: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        itemIds: {
                            type: "array",
                            items: { type: "number" }
                        }
                    },
                    required: ["tableName"]
                }
            },
            {
                name: "eq",
                description: "Get rows where a field equals a value",
                inputSchema: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        fieldName: { type: "string" },
                        value: {}
                    },
                    required: ["tableName", "fieldName", "value"]
                }
            },
            {
                name: "contains",
                description: "Get rows where a text field contains a keyword (case-insensitive)",
                inputSchema: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        fieldName: { type: "string" },
                        keyword: { type: "string" }
                    },
                    required: ["tableName", "fieldName", "keyword"]
                }
            },
            {
                name: "create_item",
                description: "Insert a new row into a table",
                inputSchema: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        itemObject: { type: "object" }
                    },
                    required: ["tableName", "itemObject"]
                }
            },
            {
                name: "update_item",
                description: "Update a row by id (itemObject must include numeric id)",
                inputSchema: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        itemObject: { type: "object" }
                    },
                    required: ["tableName", "itemObject"]
                }
            },
            {
                name: "remove_item",
                description: "Delete a row by id",
                inputSchema: {
                    type: "object",
                    properties: {
                        tableName: { type: "string" },
                        itemId: { type: "number" }
                    },
                    required: ["tableName", "itemId"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
        let result;

        switch (name) {
            case "create_table":
                await database.createTable(args.name, args.sampleObject);
                result = { success: true };
                break;

            case "remove_table":
                await database.removeTable(args.name);
                result = { success: true };
                break;

            case "clear_table":
                await database.clearTable(args.name);
                result = { success: true };
                break;

            case "get_all_tables":
                result = await database.getAllTables();
                break;

            case "get_all_items":
                result = await database(args.tableName).getAllItems(args.itemIds ?? null);
                break;

            case "eq":
                result = await database(args.tableName).eq(args.fieldName, args.value);
                break;

            case "contains":
                result = await database(args.tableName).contains(args.fieldName, args.keyword);
                break;

            case "create_item":
                result = await database(args.tableName).createItem(args.itemObject);
                break;

            case "update_item":
                await database(args.tableName).updateItem(args.itemObject);
                result = { success: true };
                break;

            case "remove_item":
                await database(args.tableName).removeItem(args.itemId);
                result = { success: true };
                break;

            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };

    } catch (err) {
        return {
            content: [{ type: "text", text: `Error: ${err.message}` }]
        };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);