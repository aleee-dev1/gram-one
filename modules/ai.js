const MISTRAL_BASE = 'https://api.mistral.ai';
const headers = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`
});



export async function embedText(text) {
    const res = await fetch(MISTRAL_BASE + '/v1/embeddings', {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "mistral-embed", input: [text] })
    });
    if (!res.ok) throw new Error(`Embed error ${res.status}: ${await res.text()}`);
    return (await res.json()).data[0].embedding;
}



export async function* streamChat(messages, model, systemPrompt, tools = null) {
    const selectedModel = model || process.env.MISTRAL_MODEL || "mistral-small-latest";

    const apiMessages = [...messages];
    if (systemPrompt) apiMessages.unshift({ role: "system", content: systemPrompt });

    const body = { model: selectedModel, stream: true, messages: apiMessages };
    if (tools?.length > 0) body.tools = tools;

    console.log(' ----------- messages start ------------');
    console.log(messages);
    console.log(' ----------- messages end ------------');
    console.log(' ------------------- tools --------------')
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