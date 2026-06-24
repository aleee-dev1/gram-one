import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

async function mistralChat(messages) {
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${MISTRAL_API_KEY}`
        },
        body: JSON.stringify({
            model: "codestral-latest",
            stream: false,
            messages,
            response_format: { type: "json_object" },
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Mistral API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.choices[0].message.content.trim();
}

const server = new Server(
    { name: "coder", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "generate_code",
            description: "Generate production-ready code from a natural language description. Returns clean, working code with no placeholders, no omissions, and no explanations — just the implementation.",
            inputSchema: {
                type: "object",
                properties: {
                    description: { type: "string" }
                },
                required: ["description"]
            }
        },
        {
            name: "fix_code",
            description: "Diagnose and fix broken code given the source and its error logs. Returns the corrected code and a precise explanation of what was wrong and what was changed.",
            inputSchema: {
                type: "object",
                properties: {
                    code: { type: "string" },
                    error_logs: { type: "string" }
                },
                required: ["code", "error_logs"]
            }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
        if (name === "generate_code") {
            const raw = await mistralChat([
                {
                    role: "system",
                    content: `You are an elite software engineer. Your sole task is to write complete, production-ready code based on a description.

RULES:
- Output ONLY a raw JSON object: {"code": "<full code here>"}
- The code must be complete — no TODOs, no placeholders, no stubs, no omitted sections
- No markdown, no code fences, no prose, no comments outside the code itself
- Use best practices, idiomatic patterns, and proper error handling for the inferred language
- If the language is not specified, infer the most appropriate one from context
- Imports, dependencies, types, and edge cases must all be handled
- The code must run as-is without modification`
                },
                {
                    role: "user",
                    content: args.description
                }
            ]);

            const parsed = JSON.parse(raw);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ success: true, content: parsed })
                    }
                ]
            };
        }

        if (name === "fix_code") {
            const raw = await mistralChat([
                {
                    role: "system",
                    content: `You are an elite software debugger and code repair specialist. You are given broken code and its error logs.

RULES:
- Output ONLY a raw JSON object: {"code": "<fixed code>", "explanation": "<what was wrong and what was changed>"}
- The fixed code must be complete and runnable — no omissions, no placeholders
- No markdown, no code fences, no prose outside the JSON
- The explanation must be precise and technical: identify the root cause(s), what exact changes were made, and why
- Fix ALL errors present — do not fix one and leave others
- Preserve the original intent and structure of the code unless it is itself the source of the bug
- If the error logs point to multiple issues, address every one of them`
                },
                {
                    role: "user",
                    content: `CODE:\n${args.code}\n\nERROR LOGS:\n${args.error_logs}`
                }
            ]);

            const parsed = JSON.parse(raw);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ success: true, content: parsed })
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
                    text: JSON.stringify({ success: false, err: err.message })
                }
            ]
        };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);