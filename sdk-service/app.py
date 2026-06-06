"""
OpenHands SDK Service — Persistent conversation manager.

Runs as a long-lived HTTP service. Worker sends tasks via POST /task.
Each session_id gets its own Conversation object that persists across requests,
enabling context retention and token savings.
"""

import os
import time
import threading
import io
import sys
from contextlib import redirect_stdout, redirect_stderr

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

app = FastAPI(title="OpenHands SDK Service")

# ─── Session storage ───────────────────────────────────────────────────────────

sessions = {}  # session_id → {conversation, lock, log_buffer, created_at, last_used}
sessions_lock = threading.Lock()

# ─── Config (from env vars) ────────────────────────────────────────────────────

LLM_MODEL = os.getenv("LLM_MODEL", "kr/minimax-m2.5")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://9router:20128/v1")
WORKSPACE_BASE = os.getenv("WORKSPACE_BASE", "/workspaces")
TASK_TIMEOUT = int(os.getenv("TASK_TIMEOUT", "600"))


# ─── Request / Response models ────────────────────────────────────────────────

class TaskRequest(BaseModel):
    session_id: str
    task: str
    workspace: Optional[str] = None  # Override workspace path (default: /workspaces/<session_id>)

class CleanupRequest(BaseModel):
    session_id: str
    delete_workspace: bool = False


# ─── Helper: capture stdout/stderr during agent execution ─────────────────────

def run_with_capture(conversation, task_text):
    """Run conversation.send_message + conversation.run() while capturing stdout/stderr."""
    log_lines = []

    # Capture stdout/stderr
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
        conversation.send_message(task_text)
        conversation.run()

    # Collect captured output
    stdout_text = stdout_capture.getvalue()
    stderr_text = stderr_capture.getvalue()

    if stdout_text:
        log_lines.extend(stdout_text.strip().split('\n'))
    if stderr_text:
        for line in stderr_text.strip().split('\n'):
            if line and 'UserWarning' not in line and 'warnings.warn' not in line:
                log_lines.append(line)

    return log_lines


# ─── Helper: extract text from MessageEvent content ──────────────────────────

def extract_text_from_event(event):
    """Extract plain text from a MessageEvent's llm_message content."""
    try:
        from openhands.sdk.event import MessageEvent
        if not isinstance(event, MessageEvent):
            return None
        if event.source != 'agent':
            return None
        text_parts = []
        for content in event.llm_message.content:
            if hasattr(content, 'text'):
                text_parts.append(content.text)
        return ''.join(text_parts).strip() if text_parts else None
    except Exception:
        return None


# ─── Helper: get or create conversation ──────────────────────────────────────

def get_or_create_session(session_id, workspace_path=None):
    """Get existing conversation or create a new one for this session."""
    with sessions_lock:
        if session_id in sessions:
            return sessions[session_id], False

    # Import SDK (only when first session is created)
    from openhands.sdk import LLM, Agent, Conversation, Tool
    from openhands.tools.file_editor import FileEditorTool
    from openhands.tools.task_tracker import TaskTrackerTool
    from openhands.tools.terminal import TerminalTool

    # Workspace
    if workspace_path:
        ws_dir = workspace_path
    else:
        ws_dir = os.path.join(WORKSPACE_BASE, session_id)
    os.makedirs(ws_dir, exist_ok=True)

    # Create LLM
    llm = LLM(
        model=f"openai/{LLM_MODEL}",
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
    )

    # Create agent with system prompt to avoid unnecessary tool use
    agent = Agent(
        llm=llm,
        tools=[
            Tool(name=TerminalTool.name),
            Tool(name=FileEditorTool.name),
            Tool(name=TaskTrackerTool.name),
        ],
        system_prompt="""You are a helpful AI assistant.

IMPORTANT RULES:
1. For simple greetings, questions, or casual chat: respond DIRECTLY without using any tools.
2. Only use tools when the user explicitly asks you to:
   - Run commands or scripts
   - Create/edit files
   - Perform coding tasks
   - Debug or analyze code
3. Be concise and conversational for non-technical messages.

PROJECT DIRECTORY:
- The main project is mounted at /project
- This contains the full automation-agent project source code
- Use /project to read, modify, or analyze project files
- Each session's workspace is at /workspaces/{session_id} for task-specific output

Examples:
- User: "Xin chào" → Reply: "Chào bạn! Tôi có thể giúp gì cho bạn?" (NO tools)
- User: "Bạn khỏe không?" → Reply directly (NO tools)
- User: "Viết cho tôi một hàm Python" → Use FileEditor tool
- User: "Chạy lệnh ls" → Use Terminal tool
- User: "Đọc file docker-compose.yml" → Read /project/docker-compose.yml
""",
    )

    # Agent response collector (shared across tasks for this session)
    agent_responses = []

    def event_callback(event):
        """Capture agent text responses from conversation events."""
        text = extract_text_from_event(event)
        if text:
            agent_responses.append(text)

    # Create conversation with session workspace and callback
    conversation = Conversation(
        agent=agent,
        workspace=ws_dir,
        callbacks=[event_callback],
        visualizer=None,  # Disable visualizer to reduce noise
    )

    session_data = {
        "conversation": conversation,
        "lock": threading.Lock(),
        "log_buffer": [],
        "agent_responses": agent_responses,
        "workspace": ws_dir,
        "created_at": time.time(),
        "last_used": time.time(),
        "task_count": 0,
    }

    with sessions_lock:
        sessions[session_id] = session_data

    return session_data, True


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/task")
async def run_task(req: TaskRequest):
    """Execute a task within a session. Creates session if new. Reuses conversation for context."""
    session_id = req.session_id
    task_text = req.task

    # Get or create session
    session_data, is_new = get_or_create_session(session_id, req.workspace)
    conversation = session_data["conversation"]
    lock = session_data["lock"]

    # Prevent concurrent tasks on same session
    if not lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Session busy with another task")

    start_time = time.time()
    status = "done"
    error_msg = None
    log_lines = []

    # Track agent responses before this task
    agent_responses = session_data["agent_responses"]
    response_count_before = len(agent_responses)

    try:
        # Run agent in a thread to support timeout
        result_container = {"lines": [], "error": None}

        def run_agent():
            try:
                lines = run_with_capture(conversation, task_text)
                result_container["lines"] = lines
            except Exception as e:
                result_container["error"] = str(e)

        agent_thread = threading.Thread(target=run_agent, daemon=True)
        agent_thread.start()
        agent_thread.join(timeout=TASK_TIMEOUT)

        if agent_thread.is_alive():
            status = "timeout"
            error_msg = f"Task exceeded {TASK_TIMEOUT}s timeout"
            log_lines = ["⏰ TIMEOUT: Task timed out"]
        elif result_container["error"]:
            status = "error"
            error_msg = result_container["error"]
            log_lines = [f"❌ Error: {error_msg}"]
        else:
            log_lines = result_container["lines"]
            status = "done"

    finally:
        lock.release()

    elapsed = round(time.time() - start_time, 1)
    session_data["last_used"] = time.time()
    session_data["task_count"] += 1
    session_data["log_buffer"].extend(log_lines)

    # Build response
    all_logs = session_data["log_buffer"]
    # Get new agent responses from this task execution
    new_responses = agent_responses[response_count_before:]
    agent_reply = new_responses[-1] if new_responses else None

    response = {
        "status": status,
        "session_id": session_id,
        "new_session": is_new,
        "task_number": session_data["task_count"],
        "duration": elapsed,
        "log_lines": len(all_logs),
        "logs": "\n".join(all_logs[-200:]),  # Last 200 lines
    }
    if agent_reply:
        response["response"] = agent_reply
    if error_msg:
        response["error"] = error_msg

    return response


@app.delete("/session/{session_id}")
async def cleanup_session(session_id: str, delete_workspace: bool = False):
    """Remove a session from memory. Optionally delete workspace files."""
    with sessions_lock:
        session_data = sessions.pop(session_id, None)

    if not session_data:
        raise HTTPException(status_code=404, detail="Session not found")

    result = {"status": "cleaned", "session_id": session_id}

    if delete_workspace and session_data.get("workspace"):
        import shutil
        try:
            shutil.rmtree(session_data["workspace"])
            result["workspace_deleted"] = True
        except Exception as e:
            result["workspace_error"] = str(e)

    return result


@app.get("/sessions")
async def list_sessions():
    """List active sessions with stats."""
    with sessions_lock:
        result = {}
        for sid, data in sessions.items():
            result[sid] = {
                "workspace": data["workspace"],
                "created_at": data["created_at"],
                "last_used": data["last_used"],
                "task_count": data["task_count"],
                "log_lines": len(data["log_buffer"]),
                "busy": data["lock"].locked(),
            }
    return {"active_sessions": len(result), "sessions": result}


@app.get("/health")
async def health():
    """Health check."""
    return {
        "status": "ok",
        "active_sessions": len(sessions),
        "llm_model": LLM_MODEL,
        "llm_base_url": LLM_BASE_URL,
        "workspace_base": WORKSPACE_BASE,
    }


@app.on_event("startup")
async def startup():
    print(f"🤖 OpenHands SDK Service started")
    print(f"   LLM: openai/{LLM_MODEL} @ {LLM_BASE_URL}")
    print(f"   Workspace: {WORKSPACE_BASE}")
    print(f"   Timeout: {TASK_TIMEOUT}s")
