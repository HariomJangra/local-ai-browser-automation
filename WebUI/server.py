"""
Flask backend for the ReAct Agent WebUI.
Streams agent thought/tool steps via Server-Sent Events (SSE).
"""

import subprocess
import json
import sys
import os
from flask import Flask, request, Response, stream_with_context, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv

# ── load .env (GROQ_API_KEY etc.) ──────────────────────────────────────────
load_dotenv()

# ── absolute path so imports resolve regardless of cwd ──────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ── LangChain imports ───────────────────────────────────────────────────────
from langchain.agents import create_agent          # type: ignore
from langchain.tools import tool                   # type: ignore
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage

# ── Browser command helper ───────────────────────────────────────────────────
def run(cmd: str) -> str:
    result = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    return result.stdout + (result.stderr if result.returncode != 0 else "")


# ── Tool definitions ─────────────────────────────────────────────────────────
@tool(
    "snapshot",
    description="Return interactive accessibility snapshot from agent-browser.")
def snapshot() -> str:
    result = run("agent-browser snapshot -i") 
    return result
    

@tool(
    "navigate",
    description=(
        "Control browser navigation using agent-browser commands. "
        "Supported commands:"
        "- 'agent-browser open <url>' → Navigate to a URL (aliases: goto, navigate)"
        "- 'agent-browser tab new <url>' -> Create New tab (url is optional)"
        "- 'agent-browser back' → Go to previous page"
        "- 'agent-browser forward' → Go to next page"
        "- 'agent-browser reload' → Reload the current page"
        "Example: agent-browser open https://youtube.com"
        "Example: agent-browser tab new https://youtube.com"
    )
)
def navigate(cmd: str) -> str:
    result = run(cmd)
    return result

@tool(
    "interact",
    description=(
        "Interact with webpage elements using agent-browser commands. "
        "Mouse actions: 'agent-browser click <selector>' to click (--new-tab to open in new tab), "
        "'agent-browser dblclick <selector>' to double-click, "
        "'agent-browser hover <selector>' to hover, "
        "'agent-browser drag <source_selector> <target_selector>' to drag and drop. "
        "Text input: 'agent-browser fill <selector> <text>' to clear and fill input, "
        "'agent-browser type <selector> <text>' to type into element, "
        "'agent-browser keyboard type <text>' to type at current focus, "
        "'agent-browser keyboard inserttext <text>' to insert text without key events, "
        "'agent-browser upload <selector> <file_paths>' to upload files. "
        "Keyboard actions: 'agent-browser press <key>' to press a key (Enter, Tab, Control+a), "
        "'agent-browser keydown <key>' to hold key down, "
        "'agent-browser keyup <key>' to release key. "
        "Form controls: 'agent-browser focus <selector>' to focus element, "
        "'agent-browser select <selector> <value>' to select dropdown option, "
        "'agent-browser check <selector>' to check checkbox, "
        "'agent-browser uncheck <selector>' to uncheck checkbox. "
        "Scrolling: 'agent-browser scroll <direction> [pixels]' to scroll (up/down/left/right, optional --selector), "
        "'agent-browser scrollintoview <selector>' to scroll element into view. "
        "Selectors must use the ref format: @e4, @e12, etc. (NOT [ref=e4]). "
        "Example: agent-browser click @e4"
    )
)
def interact(cmd: str) -> str:
    result = run(cmd)
    return result


# ── System prompt & memory ───────────────────────────────────────────────────
SYSTEM_PROMPT = (
    "You are a helpful browser automation agent. "
    "You can navigate websites, interact with elements, and take snapshots. "
    "Always take a snapshot first to understand the current page state before interacting. "
    "When the whole task given by user completes just give response as Task Completed."
)


class ConversationMemory:
    def __init__(self, system_prompt: str = SYSTEM_PROMPT):
        self.history = [SystemMessage(content=system_prompt)]

    def add(self, role: str, content: str):
        if role == "user":
            self.history.append(HumanMessage(content=content))
        else:
            self.history.append(AIMessage(content=content))

    def get(self):
        return self.history

    def clear(self):
        self.history = [self.history[0]]


memory = ConversationMemory()

# ── Agent ────────────────────────────────────────────────────────────────────
agent = create_agent("groq:openai/gpt-oss-120b", tools=[snapshot, navigate, interact])


# ── Flask app ────────────────────────────────────────────────────────────────
WEB_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=WEB_DIR, static_url_path="")
CORS(app)


def event(payload: dict) -> str:
    """Format a dict as a single SSE data line."""
    return f"data: {json.dumps(payload)}\n\n"


def stream_chat(user_input: str):
    """Generator: yields SSE events while the agent is running."""
    memory.add("user", user_input)

    ai_reply = ""

    try:
        for step in agent.stream({"messages": memory.get()}, stream_mode="updates"):
            for node, update in step.items():
                for msg in update.get("messages", []):
                    # ── agent decided to call a tool ──────────────────────
                    if hasattr(msg, "tool_calls") and msg.tool_calls:
                        for tc in msg.tool_calls:
                            yield event({
                                "type": "tool_call",
                                "name": tc["name"],
                                "args": tc["args"],
                            })

                    # ── tool returned a result ───────────────────────────
                    elif hasattr(msg, "name") and msg.name:
                        preview = (msg.content or "")[:400].replace("\n", " ")
                        yield event({
                            "type": "tool_result",
                            "name": msg.name,
                            "preview": preview,
                        })

                    # ── final AI message ─────────────────────────────────
                    elif hasattr(msg, "content") and msg.content:
                        ai_reply = msg.content
                        yield event({"type": "ai_message", "content": ai_reply})

    except Exception as exc:
        yield event({"type": "error", "content": str(exc)})

    memory.add("ai", ai_reply)
    yield event({"type": "done"})


# ── Routes ───────────────────────────────────────────────────────────────────
@app.route("/chat", methods=["POST"])
def chat_endpoint():
    data = request.get_json(silent=True) or {}
    user_input = data.get("message", "").strip()
    if not user_input:
        return {"error": "Empty message"}, 400

    return Response(
        stream_with_context(stream_chat(user_input)),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/clear", methods=["POST"])
def clear_memory():
    memory.clear()
    return {"status": "cleared"}


@app.route("/status")
def status():
    return {"status": "running", "messages": len(memory.get())}


@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=False, threaded=True)
