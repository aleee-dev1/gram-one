import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { embedText, extractFacts, streamChat } from "./modules/ai.js";
import {
    saveMessage, getMessages, getConversation, getProfile, initDb,
    getRelevantMessages, getAllFacts, saveFacts, updateConversationTitle,
    getProfiles, createProfile, updateProfile, deleteProfile,
    getConversations, createConversation, deleteConversation, getTopTools
} from "./modules/db.js";
import { initMcp, getTools, executeTool, getMcpServers } from "./modules/mcp-manager.js";

const providers = {
    mistral: {
        baseUrl: 'https://api.mistral.ai',
        key: process.env.MISTRAL_API_KEY
    },
    lmStudio: {
        baseUrl: 'http://127.0.0.1:1234',
        key: process.env.LMSTUDIO_KEY
    }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/profiles", express.static(path.join(__dirname, "public/profiles")));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index/index.html"));
});

// --- Models ---
app.get("/api/models", async (req, res) => {
    try {
        const r = await fetch(providers.mistral.baseUrl + "/v1/models", {
            headers: { Authorization: `Bearer ${providers.mistral.key}` }
        });
        if (!r.ok) throw new Error(`Models API: ${r.status}`);
        const data = await r.json();
        const models = data.data
            // .filter(m => m.capabilities?.completion_chat)
            .map(m => ({ id: m.id, name: m.id }))
            .sort((a, b) => a.id.localeCompare(b.id));
        return res.json({ source: "api", models });
    } catch (err) {
        // fallback to models.json
        try {
            const { createRequire } = await import("module");
            const require = createRequire(import.meta.url);
            const models = require("./models.json");
            return res.json({ source: "file", models });
        } catch {
            return res.status(503).json({ error: "Could not fetch models and no models.json found", source: "none" });
        }
    }
});

// --- Profiles ---
app.get("/api/profiles", async (req, res) => {
    try {
        const profiles = await getProfiles();
        res.json(profiles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/profiles", async (req, res) => {
    try {
        const { name, systemPrompt } = req.body;
        if (!name || !systemPrompt) return res.status(400).json({ error: "Missing name or system prompt" });
        const id = await createProfile(name, systemPrompt);
        res.json({ id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put("/api/profiles/:id", async (req, res) => {
    try {
        const { name, systemPrompt } = req.body;
        if (!name || !systemPrompt) return res.status(400).json({ error: "Missing name or system prompt" });
        await updateProfile(req.params.id, name, systemPrompt);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/profiles/:id", async (req, res) => {
    try {
        await deleteProfile(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- MCP Servers ---
app.get("/api/mcp-servers", async (req, res) => {
    try {
        const servers = await getMcpServers();
        res.json(servers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Conversations ---
app.get("/api/conversations", async (req, res) => {
    try {
        const convos = await getConversations();
        res.json(convos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/conversations", async (req, res) => {
    try {
        const { profile_id, mcp_servers } = req.body || {};
        const id = await createConversation(profile_id, mcp_servers);
        res.json({ id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/conversations/:id", async (req, res) => {
    try {
        await deleteConversation(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/conversations/:id/messages", async (req, res) => {
    try {
        const msgs = await getMessages(req.params.id);
        res.json(msgs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Chat (SSE streaming) ---
app.post("/api/conversations/:id/chat", async (req, res) => {
    const convId = req.params.id;
    const { message, model, continue: isContinue } = req.body;

    if (!message?.trim() && !isContinue) return res.status(400).json({ error: "Empty message" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
        const history = await getMessages(convId);

        if (message?.trim() && history.length === 0) {
            await updateConversationTitle(convId, message.slice(0, 60));
        }

        // embed user message + retrieve RAG context
        let queryEmbedding = null;
        let ragContext = "";

        if (message?.trim()) {
            queryEmbedding = await embedText(message);

            const [relevantMessages, facts] = await Promise.all([
                getRelevantMessages(convId, queryEmbedding),
                getAllFacts()
            ]);

            const factBlock = facts.length ? "Known facts about the user:\n" + facts.map(f => `- ${f.fact}`).join("\n") : "";

            const msgBlock = relevantMessages.length ? "Relevant conversation context:\n" + relevantMessages.map(r => `[${r.role}]: ${r.content}`).join("\n") : "";

            ragContext = [factBlock, msgBlock].filter(Boolean).join("\n\n");
        }

        // save user message with embedding
        if (message?.trim()) {
            await saveMessage(convId, "user", message, 0, 0, { embedding: queryEmbedding });
        }

        const conv = await getConversation(convId);
        let apiMessages = [];
        let systemPrompt = "";
        let mcpTools = [];

        if (isContinue) {
            // Find the last user message
            const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
            const userContent = lastUserMsg ? lastUserMsg.content : "N/A";

            // Find recent tool results
            const recentToolResults = [];
            for (const m of [...history].reverse()) {
                if (m.role === 'tool') recentToolResults.unshift(m);
                else if (m.role === 'assistant' && m.tool_calls) break;
            }
            const toolOutputStr = recentToolResults.map(t => `${t.tool_name || 'Tool'} Output:\n${t.content}`).join("\n\n");

            systemPrompt = "this is user question or prompt, you suggested tool call, this is tool result, now make next message telling user output of the tool how they asked";
            apiMessages = [
                { role: "user", content: `User Prompt: ${userContent}\n\nTool Result:\n${toolOutputStr}` }
            ];
        } else {
            // build API messages (no embedding field sent to API)
            apiMessages = history.map(m => {
                const msg = { role: m.role, content: m.content || "" };
                if (m.tool_calls) msg.tool_calls = m.tool_calls;
                if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
                if (m.tool_name) msg.name = m.tool_name;
                return msg;
            });
            if (message?.trim()) apiMessages.push({ role: "user", content: message });

            if (conv?.profile_id) {
                const profile = await getProfile(conv.profile_id);
                if (profile) systemPrompt = profile.system_prompt;
            }

            if (ragContext) {
                systemPrompt = systemPrompt ? `${systemPrompt}\n\n${ragContext}` : ragContext;
            }

            mcpTools = await getTopTools(queryEmbedding, conv?.mcp_servers, 5);
        }

        let aborted = false;
        req.on("close", () => { aborted = true; });

        let fullContent = "";
        let usage = null;
        let toolCallsAcc = [];

        for await (const chunk of streamChat(apiMessages, model, systemPrompt, mcpTools)) {
            if (aborted) break;
            if (chunk.type === "delta") {
                fullContent += chunk.content;
                send({ type: "delta", content: chunk.content });
            } else if (chunk.type === "tool_calls") {
                for (const tc of chunk.tool_calls) {
                    let acc = toolCallsAcc.find(t => t.index === tc.index);
                    if (!acc) {
                        acc = { index: tc.index, id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: "" } };
                        toolCallsAcc.push(acc);
                    }
                    if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                }
            } else if (chunk.type === "usage") {
                usage = chunk;
                send({ type: "usage", prompt_tokens: chunk.prompt_tokens, completion_tokens: chunk.completion_tokens });
            }
        }

        if (!aborted && fullContent && toolCallsAcc.length === 0) {
            const assistantEmb = await embedText(fullContent);
            await saveMessage(convId, "assistant", fullContent, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, { embedding: assistantEmb });
        }

        if (!aborted && toolCallsAcc.length > 0) {
            const tool_calls = toolCallsAcc.map(t => ({ id: t.id, type: "function", function: t.function }));
            await saveMessage(convId, "assistant", fullContent, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, { tool_calls });
            send({ type: "tool_calls", tool_calls });
        }

        // extract facts from user message asynchronously after streaming
        if (!aborted && message?.trim()) {
            try {
                const rawFacts = await extractFacts(message);
                if (rawFacts.length > 0) {
                    const saved = await saveFacts(rawFacts, embedText);
                    if (saved.length > 0) {
                        send({ type: "facts", facts: saved });
                    }
                }
            } catch (err) {
                console.error("Fact extraction failed:", err.message);
            }
        }

        if (!aborted) send({ type: "done" });

    } catch (err) {
        send({ type: "error", message: err.message });
    } finally {
        res.end();
    }
});

// --- Tool Execution ---
app.post("/api/conversations/:id/execute_tool", async (req, res) => {
    try {
        const { tool_call_id, name, arguments: args } = req.body;
        const [serverName, toolName] = name.split("__");
        let parsedArgs = args;
        if (typeof args === "string") {
            try { parsedArgs = JSON.parse(args); } catch (e) { }
        }

        // If the frontend explicitly passed a denial error as arguments
        if (parsedArgs && parsedArgs.error === "User denied tool execution") {
            const deniedResult = { success: false, content: "User denied tool execution" };
            await saveMessage(req.params.id, "tool", JSON.stringify(deniedResult), 0, 0, { tool_call_id, tool_name: name });
            return res.json(deniedResult);
        }

        const rawResult = await executeTool(serverName, toolName, parsedArgs);

        // Filter out bulky MCP wrappers to only keep the success boolean and raw content object
        let cleanResult = { success: true, content: rawResult };

        if (rawResult && typeof rawResult === 'object') {
            // Check for explicit standard MCP error flags
            if (rawResult.isError) cleanResult.success = false;

            if (Array.isArray(rawResult.content)) {
                // Extract text from standard MCP content array wrapper
                const textResults = rawResult.content
                    .filter(c => c.type === "text")
                    .map(c => c.text)
                    .join("\n");

                // Parse the inner text block to see if it matches your custom format
                try {
                    const innerParsed = JSON.parse(textResults);
                    if (innerParsed && typeof innerParsed === 'object' && ('success' in innerParsed || 'content' in innerParsed)) {
                        if ('success' in innerParsed) cleanResult.success = innerParsed.success;
                        if ('content' in innerParsed) cleanResult.content = innerParsed.content;
                    } else {
                        cleanResult.content = textResults;
                    }
                } catch (e) {
                    // Fallback to plain extracted text if not valid JSON
                    cleanResult.content = textResults;
                }
            } else if (rawResult.error) {
                // Check for fallback errors
                cleanResult.success = false;
                cleanResult.content = rawResult.error;
            }
        }

        // save the filtered tool response to the database so the LLM gets clean context
        await saveMessage(req.params.id, "tool", JSON.stringify(cleanResult), 0, 0, { tool_call_id, tool_name: name });
        res.json(cleanResult);
    } catch (err) {
        // Make sure hard crashes still adhere to the same minimal format for the AI context
        const errorResult = { success: false, content: err.message };
        const { tool_call_id, name } = req.body;

        if (tool_call_id && name) {
            await saveMessage(req.params.id, "tool", JSON.stringify(errorResult), 0, 0, { tool_call_id, tool_name: name });
        }
        res.status(500).json(errorResult);
    }
});

initDb()
    .then(() => initMcp())
    .then(() => {
        // console.clear();
        console.log('   GRAM ONE');
        console.log(`🚀 Listening on http://localhost:${PORT}\n`);
        // open(`http://localhost:${PORT}`)
        app.listen(PORT);
    })
    .catch(err => {
        console.error("Init failed:", err);
        process.exit(1);
    });