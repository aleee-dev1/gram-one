let profiles = [];
let activeProfileId = null;

// --- DOM Elements ---
const themeToggle = document.getElementById("theme-toggle");

// Tabs
const tabProfiles = document.getElementById("tab-profiles");
const tabConfig = document.getElementById("tab-config");

// Views
const viewProfiles = document.getElementById("view-profiles");
const viewConfig = document.getElementById("view-config");

// Profiles View
const profileList = document.getElementById("profile-list");
const editorArea = document.getElementById("editor-area");
const emptyState = document.getElementById("empty-state");
const editorTitle = document.getElementById("editor-title");
const profileNameInput = document.getElementById("profile-name");
const profilePromptInput = document.getElementById("profile-prompt");
const newProfileBtn = document.getElementById("new-profile-btn");
const saveBtn = document.getElementById("save-btn");
const saveMsg = document.getElementById("save-msg");

// Config View
const configForm = document.getElementById("configForm");
const llmBaseUrlInput = document.getElementById("llmBaseUrl");
const llmApiKeyInput = document.getElementById("llmApiKey");
const tavilyApiKeyInput = document.getElementById("tavilyApiKey");
const searchEngineSelect = document.getElementById("searchEngine");
const ddgWarning = document.getElementById("ddgWarning");
const searxngFields = document.getElementById("searxngFields");
const searxngBaseUrlInput = document.getElementById("searxngBaseUrl");
const searxngPortInput = document.getElementById("searxngPort");
const testBtn = document.getElementById("testBtn");
const statusMessage = document.getElementById("statusMessage");

// --- Theme ---
themeToggle.addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
});

// --- Tab Switching ---
tabProfiles.addEventListener("click", () => {
    tabProfiles.classList.add("active");
    tabConfig.classList.remove("active");
    viewProfiles.classList.remove("hidden");
    viewConfig.classList.add("hidden");
});

tabConfig.addEventListener("click", () => {
    tabConfig.classList.add("active");
    tabProfiles.classList.remove("active");
    viewConfig.classList.remove("hidden");
    viewProfiles.classList.add("hidden");
    loadConfig();
});

// --- Profiles ---
async function loadProfiles() {
    const res = await fetch("/api/profiles");
    profiles = await res.json();
    renderList();
}

function renderList() {
    profileList.innerHTML = "";
    profiles.forEach(p => {
        const el = document.createElement("div");
        el.className = "profile-item" + (p.id === activeProfileId ? " active" : "");
        el.title = p.name;

        const icon = document.createElement("i");
        icon.className = "fa-solid fa-user-gear profile-icon shrink-0";

        const name = document.createElement("span");
        name.className = "profile-name";
        name.textContent = p.name;

        const del = document.createElement("button");
        del.className = "del-btn";
        del.innerHTML = '<i class="fa-solid fa-trash"></i>';
        del.title = "Delete";
        del.addEventListener("click", e => { e.stopPropagation(); deleteProfile(p.id); });

        el.appendChild(icon);
        el.appendChild(name);
        el.appendChild(del);
        el.addEventListener("click", () => selectProfile(p.id));
        profileList.appendChild(el);
    });
}

function selectProfile(id) {
    activeProfileId = id;
    const profile = profiles.find(p => p.id === id);
    if (!profile) return;
    profileNameInput.value = profile.name;
    profilePromptInput.value = profile.system_prompt;
    editorTitle.textContent = profile.name;
    showEditor();
    renderList();
}

function showEditor() {
    emptyState.classList.add("hidden");
    editorArea.classList.remove("hidden");
    editorArea.classList.add("flex");
}

function hideEditor() {
    editorArea.classList.add("hidden");
    editorArea.classList.remove("flex");
    emptyState.classList.remove("hidden");
    editorTitle.textContent = "Select or create a profile";
}

newProfileBtn.addEventListener("click", () => {
    activeProfileId = "new";
    profileNameInput.value = "";
    profilePromptInput.value = "";
    editorTitle.textContent = "New Profile";
    showEditor();
    renderList();
    profileNameInput.focus();
});

saveBtn.addEventListener("click", async () => {
    const name = profileNameInput.value.trim();
    const systemPrompt = profilePromptInput.value.trim();
    if (!name || !systemPrompt) { alert("Name and System Prompt are required"); return; }

    if (activeProfileId === "new") {
        const res = await fetch("/api/profiles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, systemPrompt })
        });
        const data = await res.json();
        activeProfileId = data.id;
    } else {
        await fetch(`/api/profiles/${activeProfileId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, systemPrompt })
        });
    }

    editorTitle.textContent = name;
    showSaveMsg();
    await loadProfiles();
    selectProfile(activeProfileId);
});

async function deleteProfile(id) {
    if (!confirm("Delete this profile?")) return;
    await fetch(`/api/profiles/${id}`, { method: "DELETE" });
    if (activeProfileId === id) { activeProfileId = null; hideEditor(); }
    await loadProfiles();
}

function showSaveMsg() {
    saveMsg.style.opacity = "1";
    setTimeout(() => saveMsg.style.opacity = "0", 2000);
}

// --- Config ---
function applySearchEngineUI() {
    const engine = searchEngineSelect.value;
    if (engine === "ddg") {
        ddgWarning.classList.remove("hidden");
        searxngFields.classList.add("hidden");
    } else {
        ddgWarning.classList.add("hidden");
        searxngFields.classList.remove("hidden");
    }
}

searchEngineSelect.addEventListener("change", applySearchEngineUI);

async function loadConfig() {
    try {
        const res = await fetch("/api/config");
        if (res.ok) {
            const config = await res.json();
            if (config.base_url) llmBaseUrlInput.value = config.base_url;
            if (config.api_key) llmApiKeyInput.value = config.api_key;
            if (config.tavily_api_key) tavilyApiKeyInput.value = config.tavily_api_key;
            if (config.search_engine) searchEngineSelect.value = config.search_engine;
            if (config.searxng_base_url) searxngBaseUrlInput.value = config.searxng_base_url;
            if (config.searxng_port) searxngPortInput.value = config.searxng_port;
        }
    } catch (err) {
        console.error("Could not load config", err);
    } finally {
        applySearchEngineUI();
    }
}

function showStatus(message, isError) {
    statusMessage.textContent = message;
    statusMessage.className = `mb-6 p-4 rounded-[8px] text-[14px] ${isError ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`;
    statusMessage.classList.remove("hidden");
}

configForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const baseUrl = llmBaseUrlInput.value.trim();
    const apiKey = llmApiKeyInput.value.trim();
    const tavilyApiKey = tavilyApiKeyInput.value.trim();
    const searchEngine = searchEngineSelect.value;
    const searxngBaseUrl = searxngBaseUrlInput.value.trim();
    const searxngPort = searxngPortInput.value.trim();

    if (!baseUrl || !apiKey) return;

    testBtn.disabled = true;
    testBtn.textContent = "Testing...";
    testBtn.classList.add("opacity-70");
    statusMessage.classList.add("hidden");

    try {
        const res = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ baseUrl, apiKey, tavilyApiKey, searchEngine, searxngBaseUrl, searxngPort })
        });

        const data = await res.json();

        if (res.ok && data.success) {
            showStatus("Configuration works and was saved successfully!", false);
        } else {
            showStatus(`Error: ${data.error || 'Failed to verify configuration'}`, true);
        }
    } catch (err) {
        showStatus(`Network error: ${err.message}`, true);
    } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Save Configuration";
        testBtn.classList.remove("opacity-70");
    }
});

// --- Per-field test buttons ---
document.querySelectorAll(".test-field-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
        const target = btn.dataset.target;
        let url = "";
        let body = {};

        if (target === "llm") {
            url = "/api/test/llm";
            body = { baseUrl: llmBaseUrlInput.value.trim(), apiKey: llmApiKeyInput.value.trim() };
        } else if (target === "tavily") {
            url = "/api/test/tavily";
            body = { apiKey: tavilyApiKeyInput.value.trim() };
        } else if (target === "searxng") {
            url = "/api/test/searxng";
            body = { baseUrl: searxngBaseUrlInput.value.trim(), port: searxngPortInput.value.trim() };
        }

        const original = btn.textContent;
        btn.textContent = "Testing...";
        btn.disabled = true;

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            
            if (res.ok && data.success) {
                btn.textContent = "OK";
                btn.classList.add("border-green-400", "text-green-600");
            } else {
                btn.textContent = "Failed";
                btn.classList.add("border-red-400", "text-red-600");
                console.error("Test failed:", data.error);
            }
        } catch (err) {
            btn.textContent = "Failed";
            btn.classList.add("border-red-400", "text-red-600");
            console.error("Test error:", err);
        }

        setTimeout(() => {
            btn.textContent = original;
            btn.disabled = false;
            btn.classList.remove("border-green-400", "text-green-600", "border-red-400", "text-red-600");
        }, 2000);
    });
});

// --- Password show/hide toggles ---
document.querySelectorAll(".pw-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const input = document.getElementById(btn.dataset.target);
        const icon = btn.querySelector("i");
        const isHidden = input.type === "password";
        input.type = isHidden ? "text" : "password";
        icon.classList.toggle("fa-eye", !isHidden);
        icon.classList.toggle("fa-eye-slash", isHidden);
    });
});

// Initialize
loadProfiles();