/** --- STATE & CONSTANTS --- **/
let activeConvId = null, streaming = false, abortController = null;
let profilesData = [], mcpServersData = [], selectedProfileId = "";

const $ = (id) => document.getElementById(id);
const domPurifyConfig = { ADD_TAGS: ['i'], ADD_ATTR: ['class', 'onclick', 'data-id'] };

/** --- UTILS --- **/
const api = async (url, method = 'GET', body = null, signal = null) => {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : null,
        signal
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.headers.get('Content-Type')?.includes('application/json') ? res.json() : res;
};

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const scrollToBottom = () => $("messages").scrollTop = $("messages").scrollHeight;
const updateActiveConvUI = () => {
    document.querySelectorAll(".conv-item").forEach(el =>
        el.classList.toggle("active", Number(el.dataset.id) === activeConvId));
};

/** --- SETUP MARKED & HIGHLIGHT --- **/
marked.setOptions({ breaks: true, gfm: true });
marked.use({
    renderer: {
        code({ text, lang }) {
            const validLang = (lang && hljs.getLanguage(lang)) ? lang : 'plaintext';
            const highlighted = validLang !== 'plaintext' ? hljs.highlight(text, { language: validLang }).value : escapeHtml(text);
            return `
            <div class="code-wrapper relative my-[16px] rounded-[8px] bg-[#0d1117] border border-[#30363d] overflow-hidden">
                <div class="flex items-center justify-between px-[16px] py-[8px] bg-[#161b22] border-b border-[#30363d] text-[12px] font-sans text-[#8b949e]">
                    <span class="font-mono uppercase tracking-wider">${validLang === 'plaintext' ? 'code' : validLang}</span>
                    <button class="copy-btn flex items-center gap-[6px] hover:text-[#c9d1d9] transition-colors cursor-pointer bg-transparent border-none p-0 text-[#8b949e]" title="Copy code">
                        <i class="fa-regular fa-copy"></i> <span class="copy-text">Copy</span>
                    </button>
                </div>
                <pre class="!m-0 !p-[16px] !bg-transparent !border-none overflow-x-auto"><code class="hljs language-${validLang} !p-0 text-[13.5px] font-['Fira_Code','Cascadia_Code',monospace] leading-[1.5] text-[#c9d1d9]">${highlighted}</code></pre>
            </div>`;
        }
    }
});

/** --- UI COMPONENTS --- **/
async function loadProfiles() {
    try {
        profilesData = await api("/api/profiles");
        if (profilesData.length) {
            selectedProfileId = profilesData[0].id;
            $("profile-dropdown-label").textContent = profilesData[0].name;
            renderProfiles();
        }
    } catch (e) { $("profile-list").innerHTML = '<div class="px-[12px] py-[8px] text-[13px] text-[#e53e3e]">Failed to load</div>'; }
}

function renderProfiles() {
    $("profile-list").innerHTML = profilesData.map(p => `
        <div class="flex items-center justify-between px-[12px] py-[10px] text-[13.5px] font-medium text-[#1a1a1a] dark:text-[#e0e0e0] rounded-[8px] hover:bg-[#eef0f2] dark:hover:bg-[#2f2f2f] cursor-pointer transition-colors" onclick="selectProfile('${p.id}', '${escapeHtml(p.name)}')">
            <span>${escapeHtml(p.name)}</span>
            <i class="fa-solid fa-check text-[12px] ${p.id == selectedProfileId ? '' : 'opacity-0'}"></i>
        </div>`).join('');
}

window.selectProfile = (id, name) => {
    selectedProfileId = id;
    $("profile-dropdown-label").textContent = name;
    renderProfiles();
    $("profile-dropdown-menu").classList.add("hidden");
};

async function loadModels() {
    try {
        const data = await api("/api/models");
        const select = $("model-select");
        select.innerHTML = (data.models || []).map(m => `<option value="${m.id}">${m.id}</option>`).join('') || '<option value="">No models</option>';
        const saved = localStorage.getItem("selectedModel");
        if (saved && [...select.options].some(o => o.value === saved)) select.value = saved;

        $("model-source").textContent = data.source?.toUpperCase() || "ERR";
        $("model-source").className = `status-badge ${data.source || 'none'}`;
    } catch { $("model-source").className = "status-badge none"; }
}

async function loadMcpServers() {
    try {
        mcpServersData = await api("/api/mcp-servers");
        $("mcp-list").innerHTML = mcpServersData.map(s => `
            <div class="flex items-center justify-between">
                <span class="text-[13.5px] font-medium text-[#1a1a1a] dark:text-[#e0e0e0] mr-3 whitespace-normal leading-tight">${escapeHtml(s.name)}</span>
                <label class="relative inline-flex items-center cursor-pointer shrink-0">
                    <input type="checkbox" value="${s.id}" class="sr-only peer mcp-toggle-input" checked>
                    <div class="w-9 h-5 bg-[#d2d6da] dark:bg-[#444] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#1a1a1a] dark:peer-checked:bg-[#e0e0e0] peer-disabled:opacity-50"></div>
                </label>
            </div>`).join('');
        updateMcpTogglesState();
    } catch (e) { mcpServersData = []; }
}

/** --- CONVERSATION LOGIC --- **/
async function loadConversations() {
    const convos = await api("/api/conversations");
    $("conv-list").innerHTML = "";
    [...convos].reverse().forEach(renderConvItem);
    return convos;
}

function renderConvItem(c) {
    const el = document.createElement("div");
    el.className = `conv-item ${c.id === activeConvId ? 'active' : ''}`;
    el.dataset.id = c.id;
    el.innerHTML = `<i class="fa-regular fa-message conv-icon shrink-0"></i><span class="conv-title">${escapeHtml(c.title || "New Conversation")}</span>`;

    const del = document.createElement("button");
    del.className = "conv-delete";
    del.innerHTML = '<i class="fa-solid fa-trash"></i>';
    del.onclick = async (e) => {
        e.stopPropagation();
        if (await confirmDelete()) {
            await api(`/api/conversations/${c.id}`, 'DELETE');
            if (activeConvId === c.id) setNewState();
            el.remove();
        }
    };
    el.appendChild(del);
    el.onclick = () => !streaming && selectConversation(c.id, c.title, c.profile_id, c.mcp_servers);
    $("conv-list").prepend(el);
}

async function selectConversation(id, title, profileId, mcpServers) {
    activeConvId = id;
    $("chat-title").textContent = title || "New Conversation";
    toggleChatUI(true);

    $("profile-dropdown-btn").disabled = true;
    if (profileId) {
        selectedProfileId = profileId;
        const p = profilesData.find(x => x.id == profileId);
        if (p) $("profile-dropdown-label").textContent = p.name;
        renderProfiles();
    }

    document.querySelectorAll('.mcp-toggle-input').forEach(t => t.checked = mcpServers?.includes(t.value));
    updateMcpTogglesState();
    updateActiveConvUI();

    $("messages").innerHTML = "";
    const msgs = await api(`/api/conversations/${id}/messages`);
    msgs.forEach(m => {
        const { toolsContainer } = appendMessage(m.role, m.content, { prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens, tool_name: m.tool_name });
        (m.tool_calls || []).forEach(tc => appendToolCallUI(toolsContainer, tc, true));
    });
    scrollToBottom();
}

function setNewState() {
    activeConvId = "new";
    $("chat-title").textContent = "New Conversation";
    $("messages").innerHTML = "";
    toggleChatUI(false);
    $("profile-dropdown-btn").disabled = false;
    document.querySelectorAll('.mcp-toggle-input').forEach(t => t.checked = true);
    updateMcpTogglesState();
    updateActiveConvUI();
}

function toggleChatUI(isChatting) {
    $("chat-header").classList.toggle("hidden", !isChatting);
    $("messages").classList.toggle("hidden", !isChatting);
    $("empty-state").classList.toggle("hidden", isChatting);
    $("chat-area").classList.toggle("justify-center", !isChatting);
}

function updateMcpTogglesState() {
    const isNew = activeConvId === "new";
    $("mcp-dropdown-btn").disabled = !isNew;
    document.querySelectorAll('.mcp-toggle-input').forEach(t => t.disabled = !isNew);
}

/** --- MESSAGING --- **/
function appendMessage(role, content = "", options = null) {
    const wrap = document.createElement("div");
    wrap.className = "message";

    let avatarHtml = role === 'user' ? '<img src="https://ui-avatars.com/api/?name=User&background=random">' :
        role === 'tool' ? '<i class="fa-solid fa-wrench"></i>' : '<img src="/assets/logo.png">';

    let author = role === 'user' ? 'User' : role === 'tool' ? 'Tool Result' : (profilesData.find(p => p.id == selectedProfileId)?.name || 'Assistant');

    wrap.innerHTML = `
        <div class="msg-avatar ${role} ${role === 'tool' ? 'bg-[#e8f5e9] dark:bg-[rgba(63,185,80,0.1)] text-[#2e7d32] dark:text-[#3fb950]' : ''}">${avatarHtml}</div>
        <div class="msg-content-wrapper">
            <div class="msg-header">
                <div class="msg-header-left flex items-baseline gap-[12px]">
                    <span class="msg-author">${author}</span>
                    <span class="msg-time">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()}</span>
                </div>
                <div class="msg-header-right token-info-container flex items-center justify-end"></div>
            </div>
            <div class="bubble w-full"></div>
            <div class="tools-container flex flex-col gap-[8px]"></div>
        </div>`;

    const bubble = wrap.querySelector(".bubble");
    if (role === "assistant") bubble.innerHTML = DOMPurify.sanitize(marked.parse(content), domPurifyConfig);
    else if (role === "tool") renderToolResult(bubble, content, options?.tool_name);
    else bubble.textContent = content;

    const contentWrap = wrap.querySelector(".msg-content-wrapper");
    if (options?.prompt_tokens) appendTokenInfo(contentWrap, options.prompt_tokens, options.completion_tokens);

    $("messages").appendChild(wrap);
    return { bubble, toolsContainer: wrap.querySelector(".tools-container"), contentWrap };
}

function renderToolResult(el, content, toolNameRaw = "") {
    let isSuccess = true, display = content;
    let isWebSearch = false;
    let searchResultsHtml = "";

    try {
        const p = JSON.parse(content);
        if (p && typeof p === 'object') {
            isSuccess = p.success !== false;
            display = typeof p.content === 'string' ? p.content : JSON.stringify(p.content, null, 2);
            
            let resultsData = null;
            let rawParsed = typeof p.content === 'string' ? null : p.content;
            
            if (typeof p.content === 'string') {
                try { rawParsed = JSON.parse(p.content); } catch(e) {}
            }
            
            if (rawParsed && typeof rawParsed === 'object') {
                if (Array.isArray(rawParsed)) {
                    resultsData = rawParsed;
                } else if (rawParsed.results && Array.isArray(rawParsed.results)) {
                    resultsData = rawParsed.results;
                } else if (rawParsed.data && Array.isArray(rawParsed.data)) {
                    resultsData = rawParsed.data;
                }
            }
            
            if (resultsData && Array.isArray(resultsData) && resultsData.length > 0 && (resultsData[0].url || resultsData[0].link)) {
                if (toolNameRaw && toolNameRaw.toLowerCase().includes('search')) {
                    isWebSearch = true;
                    searchResultsHtml = '<div class="flex flex-col gap-[12px]">' + resultsData.map(res => {
                        const url = res.url || res.link || "";
                        const title = res.title || res.name || url;
                        const desc = res.description || res.snippet || res.content || '';
                        
                        let domain = "";
                        try {
                            domain = new URL(url).hostname;
                        } catch(e) {}

                        return `
                            <div class="border border-[#eef0f2] dark:border-[#3d3d3d] rounded-[8px] p-[12px] bg-[#ffffff] dark:bg-[#242424] hover:border-[#d2d6da] dark:hover:border-[#555] transition-colors">
                                <div class="flex items-center gap-[8px] mb-[4px] overflow-hidden">
                                    ${domain ? `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" class="w-[16px] h-[16px] rounded-[2px] bg-white shrink-0" />` : '<i class="fa-solid fa-globe text-[#8b949e] text-[14px] shrink-0"></i>'}
                                    <a href="${url}" target="_blank" class="text-[14px] font-semibold text-[#1a1a1a] dark:text-[#e0e0e0] hover:underline truncate">${escapeHtml(title)}</a>
                                </div>
                                <div class="text-[11px] text-[#adb5bd] dark:text-[#8b949e] mb-[8px] truncate"><a href="${url}" target="_blank" class="hover:underline text-[#adb5bd] dark:text-[#8b949e]">${escapeHtml(url)}</a></div>
                                <p class="text-[13px] text-[#6c757d] dark:text-[#a0a0a0] leading-[1.5] m-0">${escapeHtml(desc)}</p>
                            </div>
                        `;
                    }).join('') + '</div>';
                }
            }
        }
    } catch { }

    const color = isSuccess ? '#3fb950' : '#e53e3e';

    let serverName = "Unknown", toolName = "Unknown";
    if (toolNameRaw && toolNameRaw.includes("__")) {
        [serverName, toolName] = toolNameRaw.split("__");
    } else if (toolNameRaw) {
        toolName = toolNameRaw;
    }
    let headerText = toolNameRaw ? `${escapeHtml(serverName)} / ${escapeHtml(toolName)}` : "Tool Result";
    
    const contentClass = isWebSearch ? "" : "hidden";
    const chevronClass = isWebSearch ? "rotate-180" : "";

    el.innerHTML = `
        <div class="tool-result-box border border-[#eef0f2] dark:border-[#3d3d3d] rounded-[8px] bg-[#f0f0f0] dark:bg-[#1e1e1e] overflow-hidden mt-[4px] w-full">
            <div class="tool-result-header flex items-center justify-between p-[12px] cursor-pointer hover:bg-[#eef0f2] dark:hover:bg-[#2f2f2f] transition-colors" onclick="this.nextElementSibling.classList.toggle('hidden'); this.querySelector('.fa-chevron-down').classList.toggle('rotate-180')">
                <div class="flex items-center gap-[10px]">
                    <div class="w-[10px] h-[10px] rounded-full bg-[${color}] shadow-[0_0_4px_${color}]"></div>
                    <span class="text-[13px] font-semibold text-[#1a1a1a] dark:text-[#c9d1d9]">${headerText}</span>
                </div>
                <i class="fa-solid fa-chevron-down text-[12px] transition-transform ${chevronClass}"></i>
            </div>
            <div class="tool-result-content ${contentClass} p-[12px] border-t border-[#eef0f2] dark:border-[#3d3d3d] overflow-x-auto">
                ${isWebSearch ? searchResultsHtml : `<pre class="text-[12.5px] whitespace-pre-wrap m-0 font-mono">${escapeHtml(display)}</pre>`}
            </div>
        </div>`;
}

function appendToolCallUI(container, tc, executed = false) {
    const wrap = document.createElement("div");
    wrap.className = "tool-call p-[16px] bg-[#f0f0f0] dark:bg-[#1e1e1e] border border-[#eef0f2] dark:border-[#3d3d3d] rounded-[8px] w-full box-border mt-[8px]";
    wrap.innerHTML = `
        <div class="flex items-center justify-between mb-[8px]">
            <span class="font-mono text-[13px] font-semibold text-[#6c757d] dark:text-[#8b949e] break-all">Tool Call: ${tc.function.name}</span>
            ${executed ? '<span class="text-[13px] text-[#2e7d32] dark:text-[#3fb950] font-medium">Executed</span>' : ''}
        </div>
        <pre class="text-[13px] p-[12px] bg-[#ffffff] dark:bg-[#2f2f2f] border border-[#eef0f2] dark:border-[#3d3d3d] rounded-[6px] font-mono whitespace-pre-wrap">${escapeHtml(tc.function.arguments)}</pre>
        ${executed ? '' : `
        <div class="flex gap-[8px] action-buttons mt-[8px]">
            <button class="allow-btn px-[16px] py-[6px] bg-[#1a1a1a] dark:bg-[#e0e0e0] text-white dark:text-[#1a1a1a] rounded-[6px] text-[13px] font-medium cursor-pointer">Allow</button>
            <button class="deny-btn px-[16px] py-[6px] bg-[#e53e3e] dark:bg-[#da3633] text-white rounded-[6px] text-[13px] font-medium cursor-pointer">Deny</button>
        </div>`} `;

    if (!executed) {
        wrap.querySelector('.allow-btn').onclick = () => handleToolDecision(wrap, tc, true);
        wrap.querySelector('.deny-btn').onclick = () => handleToolDecision(wrap, tc, false);
    }
    container.appendChild(wrap);
}

async function handleToolDecision(wrap, tc, allowed) {
    const btnArea = wrap.querySelector('.action-buttons');
    btnArea.innerHTML = `<span class="text-[13px] font-medium text-[#6c757d]">${allowed ? 'Executing...' : 'Denied'}</span>`;
    try {
        const body = { tool_call_id: tc.id, name: tc.function.name, arguments: allowed ? tc.function.arguments : '{"error": "User denied tool execution"}' };
        const trData = await api(`/api/conversations/${activeConvId}/execute_tool`, 'POST', body);
        btnArea.innerHTML = `<span class="text-[13px] font-medium ${allowed ? 'text-[#2e7d32]' : 'text-[#e53e3e]'}">${allowed ? 'Done' : 'Denied'}</span>`;
        appendMessage("tool", typeof trData === 'string' ? trData : JSON.stringify(trData), { tool_name: tc.function.name });
        scrollToBottom();
        sendMessage({ isContinue: true });
    } catch (err) {
        btnArea.innerHTML = `<span class="text-[13px] font-medium text-[#e53e3e]">Error: ${err.message}</span>`;
    }
}

function appendTokenInfo(contentWrap, p, c) {
    const target = contentWrap.querySelector('.token-info-container');
    if (target) target.innerHTML = `<span class="token-info">↑ ${p} prompt · ${c} completion</span>`;
}

/** --- SENDING & STREAMING --- **/
async function sendMessage({ text = "", isContinue = false } = {}) {
    if (!isContinue) {
        text = $("user-input").value.trim();
        if (!text) return;
        $("user-input").value = "";
        autoResize();
    }

    if (activeConvId === "new") {
        const { id } = await api("/api/conversations", "POST", {
            profile_id: selectedProfileId,
            mcp_servers: Array.from(document.querySelectorAll('.mcp-toggle-input:checked')).map(t => t.value)
        });
        activeConvId = id;
        renderConvItem({ id, title: "New Conversation", profile_id: selectedProfileId });
        toggleChatUI(true);
        updateMcpTogglesState();
        updateActiveConvUI();
    }

    streaming = true;
    abortController = new AbortController();
    $("send-btn").innerHTML = '<i class="fa-solid fa-stop"></i>';

    if (!isContinue) appendMessage("user", text);
    const { contentWrap, bubble, toolsContainer } = appendMessage("assistant", "");
    bubble.classList.add("cursor");
    scrollToBottom();

    let fullContent = "", usage = null, errored = false;

    try {
        const res = await api(`/api/conversations/${activeConvId}/chat`, "POST", { message: text, model: $("model-select").value, continue: isContinue }, abortController.signal);
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
                try {
                    const parsed = JSON.parse(line.slice(5).trim());
                    if (parsed.type === "delta") {
                        fullContent += parsed.content;
                        bubble.innerHTML = DOMPurify.sanitize(marked.parse(fullContent), domPurifyConfig);
                    } else if (parsed.type === "tool_calls") {
                        parsed.tool_calls.forEach(tc => appendToolCallUI(toolsContainer, tc));
                    } else if (parsed.type === "usage") usage = parsed;
                    else if (parsed.type === "error") throw new Error(parsed.message);
                    scrollToBottom();
                } catch { }
            }
        }
    } catch (err) {
        if (err.name !== "AbortError") {
            errored = true;
            contentWrap.insertAdjacentHTML('beforeend', `<div class="message-error">Error: ${err.message}. You can retry.</div>`);
        }
    } finally {
        bubble.classList.remove("cursor");
        if (!errored && usage) appendTokenInfo(contentWrap, usage.prompt_tokens, usage.completion_tokens);
        streaming = false;
        abortController = null;
        $("send-btn").innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
        loadConversations().then(updateActiveConvUI);
        scrollToBottom();
        $("user-input").focus();
    }
}

/** --- EVENT LISTENERS --- **/
$("sidebar-toggle").onclick = () => {
    $("sidebar").classList.toggle("collapsed");
    localStorage.setItem("sidebar-collapsed", $("sidebar").classList.contains("collapsed"));
};

$("theme-toggle").onclick = () => {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
};

$("profile-dropdown-btn").onclick = (e) => {
    e.stopPropagation();
    $("profile-dropdown-menu").classList.toggle("hidden");
    $("mcp-dropdown-menu").classList.add("hidden");
};

$("mcp-dropdown-btn").onclick = (e) => {
    e.stopPropagation();
    $("mcp-dropdown-menu").classList.toggle("hidden");
    $("profile-dropdown-menu").classList.add("hidden");
};

document.onclick = (e) => {
    if (!e.target.closest('#profile-dropdown-btn') && !e.target.closest('#profile-dropdown-menu')) $("profile-dropdown-menu").classList.add("hidden");
    if (!e.target.closest('#mcp-dropdown-btn') && !e.target.closest('#mcp-dropdown-menu')) $("mcp-dropdown-menu").classList.add("hidden");
};

$("send-btn").onclick = () => streaming ? abortController?.abort() : sendMessage();
$("new-chat-btn").onclick = () => !streaming && (setNewState() || $("user-input").focus());
$("model-select").onchange = (e) => localStorage.setItem("selectedModel", e.target.value);
$("user-input").oninput = autoResize;
$("user-input").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); streaming ? abortController?.abort() : sendMessage(); } };

// Copy Code logic
$("messages").onclick = async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = btn.closest('.code-wrapper').querySelector('code').textContent;
    await navigator.clipboard.writeText(code);
    const icon = btn.querySelector('i'), text = btn.querySelector('.copy-text');
    icon.className = 'fa-solid fa-check text-[#3fb950]';
    text.textContent = 'Copied!';
    setTimeout(() => { icon.className = 'fa-regular fa-copy'; text.textContent = 'Copy'; }, 2000);
};

function autoResize() {
    $("user-input").style.height = "auto";
    $("user-input").style.height = Math.min($("user-input").scrollHeight, 180) + "px";
}

function confirmDelete() {
    return new Promise(res => {
        $("delete-modal").classList.remove('hidden');
        const done = (val) => { $("delete-modal").classList.add('hidden'); res(val); };
        $("confirm-delete").onclick = () => done(true);
        $("cancel-delete").onclick = () => done(false);
    });
}

/** --- INIT --- **/
(async () => {
    if (localStorage.getItem("sidebar-collapsed") === "true") $("sidebar").classList.add("collapsed");
    if (localStorage.getItem("theme") === "dark") document.documentElement.classList.add("dark");

    const h = new Date().getHours();
    const greeting = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    $("greeting-text").innerHTML = `<i class="fa-solid fa-sun text-[#d97757] text-[28px] rotate-180"></i> ${greeting}`;

    loadModels();
    loadMcpServers();
    await loadProfiles();
    
    const convos = await loadConversations();
    if (!convos.length) setNewState();
    else selectConversation(convos[0].id, convos[0].title, convos[0].profile_id, convos[0].mcp_servers);
})();