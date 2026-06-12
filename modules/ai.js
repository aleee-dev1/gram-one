const MISTRAL_BASE = 'https://api.mistral.ai';
const headers = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`
});

const FACT_EXTRACTION_PROMPT = `You are a fact extractor. Respond ONLY in this JSON format:
{"facts": ["fact1", "fact2"]}

Extract facts ONLY if explicitly stated by the user in their message.
Write each fact as a full declarative sentence e.g. "The user's name is Stark", "The user's keys are under the bed".
Only extract durable, reusable facts:
- Personal identity: name, age, location, occupation
- Owned objects and where they are
- Stated preferences, habits, or routines
- Explicit relationships: family, friends, colleagues

Do NOT extract:
- Emotions, moods, or temporary states
- Opinions or subjective statements
- Questions or hypotheticals
- Anything implicit or inferred
- Facts from your own response, only from the user message

If nothing qualifies, return {"facts": []}.`;

export async function embedText(text) {
    const res = await fetch(MISTRAL_BASE + '/v1/embeddings', {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "mistral-embed", input: [text] })
    });
    if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
    return (await res.json()).data[0].embedding;
}

export async function extractFacts(userMessage) {
    const res = await fetch(MISTRAL_BASE + '/v1/chat/completions', {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
            model: "mistral-small-latest",
            max_tokens: 512,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: FACT_EXTRACTION_PROMPT },
                { role: "user", content: userMessage }
            ]
        })
    });
    if (!res.ok) throw new Error(`Facts error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    try {
        const parsed = JSON.parse(data.choices[0].message.content);
        return Array.isArray(parsed.facts) ? parsed.facts : [];
    } catch {
        return [];

    }
}

export async function* streamChat(messages, model, systemPrompt, tools = null) {
    const selectedModel = model || process.env.MISTRAL_MODEL || "mistral-small-latest";

    const apiMessages = [...messages];
    if (systemPrompt) apiMessages.unshift({ role: "system", content: systemPrompt });

    const body = { model: selectedModel, stream: true, messages: apiMessages };
    if (tools?.length > 0) body.tools = tools;

    console.log('body start');
    console.log(messages);
    console.log(systemPrompt);
    tools.forEach(t => console.log(t.function.name));
    console.log('body end');

    const res = await fetch(MISTRAL_BASE + '/v1/chat/completions', {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error(`Mistral API error ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();

        for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (raw === "[DONE]") return;

            let parsed;
            try { parsed = JSON.parse(raw); } catch { continue; }

            if (parsed.usage) {
                yield { type: "usage", prompt_tokens: parsed.usage.prompt_tokens, completion_tokens: parsed.usage.completion_tokens };
            }

            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
                if (delta.content) yield { type: "delta", content: delta.content };
                if (delta.tool_calls) yield { type: "tool_calls", tool_calls: delta.tool_calls };
            }
        }
    }
}