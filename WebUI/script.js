/* ── Config ──────────────────────────────────────────────────────────────── */
const API_BASE = "http://localhost:5050";

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const promptInput  = document.getElementById("promptInput");
const sendBtn      = document.getElementById("sendBtn");
const clearBtn     = document.getElementById("clearBtn");
const messages     = document.getElementById("messages");
const emptyState   = document.getElementById("emptyState");
const msgCount     = document.getElementById("msgCount");

/* ── State ───────────────────────────────────────────────────────────────── */
let streaming = false;
let contextCount = 0;

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scrollBottom() {
  const area = document.getElementById("chatArea");
  area.scrollTop = area.scrollHeight;
}

function updateContextBadge(count) {
  contextCount = count;
  msgCount.textContent = count;
}

function hideEmptyState() {
  emptyState.classList.add("hidden");
}

function setSendBtnState(loading) {
  streaming = loading;
  if (loading) {
    sendBtn.disabled = true;
    sendBtn.classList.add("loading");
  } else {
    sendBtn.classList.remove("loading");
    updateSendBtnEnabled();
  }
}

function updateSendBtnEnabled() {
  const hasText = promptInput.value.trim().length > 0;
  sendBtn.disabled = !hasText || streaming;
  sendBtn.style.opacity = hasText && !streaming ? "1" : "";
  sendBtn.style.pointerEvents = hasText && !streaming ? "auto" : "";
}

/* ── Auto-grow textarea ──────────────────────────────────────────────────── */
function autoGrow() {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + "px";
}

/* ── Render helpers ──────────────────────────────────────────────────────── */
function createMsgEl(role) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const label = document.createElement("div");
  label.className = "msg-role";
  label.textContent = role === "user" ? "You" : "Agent";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  return bubble;
}

function addUserMessage(text) {
  hideEmptyState();
  const bubble = createMsgEl("user");
  bubble.textContent = text;
  scrollBottom();
}

function addTypingIndicator() {
  const bubble = createMsgEl("ai");
  bubble.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  scrollBottom();
  return bubble;
}

function addToolEvent(type, payload) {
  const el = document.createElement("div");
  el.className = `tool-event ${type}`;

  const icons = { call: "⚙️", result: "✅", error: "❌" };
  el.innerHTML = `
    <span class="tool-icon">${icons[type] || "•"}</span>
    <div class="tool-body">
      <div class="tool-name">${escapeHtml(payload.name || type)}</div>
      <div class="tool-detail">${escapeHtml(payload.detail || "")}</div>
    </div>`;

  messages.appendChild(el);
  scrollBottom();
}

/* ── Send logic (SSE streaming) ──────────────────────────────────────────── */
async function sendMessage() {
  const text = promptInput.value.trim();
  if (!text || streaming) return;

  // Reset input
  promptInput.value = "";
  autoGrow();
  setSendBtnState(true);

  // Show user message
  addUserMessage(text);

  // Placeholder AI bubble with typing dots
  const aiBubble = addTypingIndicator();

  let aiText = "";
  let aiStarted = false;

  try {
    const resp = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!resp.ok) {
      throw new Error(`Server error ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        switch (evt.type) {
          case "tool_call":
            addToolEvent("call", {
              name: evt.name,
              detail: JSON.stringify(evt.args),
            });
            break;

          case "tool_result":
            addToolEvent("result", {
              name: evt.name,
              detail: evt.preview,
            });
            break;

          case "ai_message":
            if (!aiStarted) {
              aiStarted = true;
              aiBubble.textContent = "";
            }
            aiText = evt.content;
            aiBubble.textContent = aiText;
            scrollBottom();
            break;

          case "error":
            aiBubble.parentElement.querySelector(".msg-role").textContent = "Error";
            aiBubble.textContent = evt.content;
            aiBubble.style.color = "#dc2626";
            break;

          case "done":
            if (!aiStarted) {
              aiBubble.textContent = "(No response)";
            }
            // Refresh context count
            fetchStatus();
            break;
        }
      }
    }
  } catch (err) {
    aiBubble.parentElement.querySelector(".msg-role").textContent = "Error";
    aiBubble.textContent = "Could not reach the agent server. Make sure server.py is running on port 5050.";
    aiBubble.style.color = "#dc2626";
  } finally {
    setSendBtnState(false);
    scrollBottom();
  }
}

/* ── Clear conversation ──────────────────────────────────────────────────── */
async function clearConversation() {
  try {
    await fetch(`${API_BASE}/clear`, { method: "POST" });
  } catch (_) { /* offline – still clear locally */ }

  messages.innerHTML = "";
  emptyState.classList.remove("hidden");
  updateContextBadge(0);
  promptInput.focus();
}

/* ── Fetch context count ─────────────────────────────────────────────────── */
async function fetchStatus() {
  try {
    const r = await fetch(`${API_BASE}/status`);
    const d = await r.json();
    updateContextBadge(d.messages ?? 0);
  } catch (_) { /* server might not be up */ }
}

/* ── Event listeners ─────────────────────────────────────────────────────── */
promptInput.addEventListener("input", () => {
  autoGrow();
  updateSendBtnEnabled();
});

promptInput.addEventListener("keydown", (e) => {
  // Enter to send; Shift+Enter for newline
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);
clearBtn.addEventListener("click", clearConversation);

/* ── Init ────────────────────────────────────────────────────────────────── */
fetchStatus();
promptInput.focus();
