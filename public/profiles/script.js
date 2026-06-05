let profiles = [];
let activeProfileId = null;

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const profileList = document.getElementById("profile-list");
const editorArea = document.getElementById("editor-area");
const emptyState = document.getElementById("empty-state");
const editorTitle = document.getElementById("editor-title");
const profileNameInput = document.getElementById("profile-name");
const profilePromptInput = document.getElementById("profile-prompt");
const newProfileBtn = document.getElementById("new-profile-btn");
const saveBtn = document.getElementById("save-btn");
const saveMsg = document.getElementById("save-msg");
const themeToggle = document.getElementById("theme-toggle");

// --- Sidebar Toggle ---
if (localStorage.getItem("sidebar-collapsed") === "true") {
    sidebar.classList.add("collapsed");
}

sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    localStorage.setItem("sidebar-collapsed", sidebar.classList.contains("collapsed"));
});

// --- Theme ---
themeToggle.addEventListener("click", () => {
    document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
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
        el.title = p.name; // Gives a nice tooltip on hover when sidebar is collapsed

        // Added file icon that remains visible when collapsed
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

loadProfiles();