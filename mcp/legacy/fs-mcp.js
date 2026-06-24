import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
let dir = path.dirname(__filename);

while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Root not found");
    dir = parent;
}

const ROOT = path.join(dir, "sandbox");

function resolve(userPath = ".") {
    const cleanPath = userPath.replace(/^\/+/, "");

    const resolved = path.resolve(ROOT, cleanPath);

    if (
        resolved !== ROOT &&
        !resolved.startsWith(ROOT + path.sep)
    ) {
        throw new Error("Access denied: path is outside sandbox");
    }

    return resolved;
}

function ok(content) {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({ success: true, content })
        }]
    };
}

function err(message) {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({ success: false, content: message })
        }]
    };
}

const server = new Server(
    { name: "filesystem-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "read_file",
            description: "Read the contents of a file at the given path.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
            }
        },
        {
            name: "write_file",
            description: "Write content to a file, overwriting if it exists.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    content: { type: "string" }
                },
                required: ["path", "content"]
            }
        },
        {
            name: "append_file",
            description: "Append content to the end of a file.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    content: { type: "string" }
                },
                required: ["path", "content"]
            }
        },
        {
            name: "delete_file",
            description: "Delete a file at the given path.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
            }
        },
        {
            name: "move_file",
            description: "Move or rename a file from source to destination.",
            inputSchema: {
                type: "object",
                properties: {
                    source: { type: "string" },
                    destination: { type: "string" }
                },
                required: ["source", "destination"]
            }
        },
        {
            name: "copy_file",
            description: "Copy a file from source to destination.",
            inputSchema: {
                type: "object",
                properties: {
                    source: { type: "string" },
                    destination: { type: "string" }
                },
                required: ["source", "destination"]
            }
        },
        {
            name: "list_directory",
            description: "List files and folders inside a directory.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
            }
        },
        {
            name: "create_directory",
            description: "Create a directory, including nested directories.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
            }
        },
        {
            name: "delete_directory",
            description: "Recursively delete a directory and all its contents.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
            }
        },
        {
            name: "stat",
            description: "Get metadata of a file or directory: size, timestamps, type.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"]
            }
        },
        {
            name: "search_files",
            description: "Recursively search for files by name pattern (substring match) within a directory.",
            inputSchema: {
                type: "object",
                properties: {
                    directory: { type: "string" },
                    pattern: { type: "string" }
                },
                required: ["directory", "pattern"]
            }
        },
        {
            name: "grep",
            description: "Search for a regex pattern inside file contents within a directory recursively. Returns matching file paths and lines.",
            inputSchema: {
                type: "object",
                properties: {
                    directory: { type: "string" },
                    pattern: { type: "string" }
                },
                required: ["directory", "pattern"]
            }
        }
    ]
}));

async function walkDir(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await walkDir(fullPath));
        } else {
            results.push(fullPath);
        }
    }
    return results;
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
        if (name === "read_file") {
            const content = await fsp.readFile(resolve(args.path), "utf-8");
            return ok(content);
        }

        if (name === "write_file") {
            await fsp.writeFile(resolve(args.path), args.content, "utf-8");
            return ok("File written");
        }

        if (name === "append_file") {
            await fsp.appendFile(resolve(args.path), args.content, "utf-8");
            return ok("Content appended");
        }

        if (name === "delete_file") {
            await fsp.unlink(resolve(args.path));
            return ok("File deleted");
        }

        if (name === "move_file") {
            await fsp.rename(resolve(args.source), resolve(args.destination));
            return ok("File moved");
        }

        if (name === "copy_file") {
            await fsp.copyFile(resolve(args.source), resolve(args.destination));
            return ok("File copied");
        }

        if (name === "list_directory") {
            const entries = await fsp.readdir(resolve(args.path), { withFileTypes: true });
            const content = entries.map(e => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : "file"
            }));
            return ok(content);
        }

        if (name === "create_directory") {
            await fsp.mkdir(resolve(args.path), { recursive: true });
            return ok("Directory created");
        }

        if (name === "delete_directory") {
            await fsp.rm(resolve(args.path), { recursive: true, force: true });
            return ok("Directory deleted");
        }

        if (name === "stat") {
            const s = await fsp.stat(resolve(args.path));
            return ok({
                size: s.size,
                isFile: s.isFile(),
                isDirectory: s.isDirectory(),
                created: s.birthtime,
                modified: s.mtime,
                accessed: s.atime,
                mode: s.mode.toString(8)
            });
        }

        if (name === "search_files") {
            const all = await walkDir(resolve(args.directory));
            const matches = all.filter(f => path.basename(f).includes(args.pattern));
            return ok(matches);
        }

        if (name === "grep") {
            const all = await walkDir(resolve(args.directory));
            const regex = new RegExp(args.pattern);
            const results = [];
            for (const file of all) {
                try {
                    const text = await fsp.readFile(file, "utf-8");
                    const lines = text.split("\n");
                    const hits = lines
                        .map((line, i) => ({ line: i + 1, text: line }))
                        .filter(({ text }) => regex.test(text));
                    if (hits.length > 0) results.push({ file, hits });
                } catch {
                    // skip unreadable files
                }
            }
            return ok(results);
        }

        throw new Error("Unknown tool");
    } catch (e) {
        return err(e.message);
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);