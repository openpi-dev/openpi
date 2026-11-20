"""Export one agent's history from a Devin CLI session to a redacted Markdown transcript.

Usage: python3 export_session.py <session_id> <lead|sidekick|subagents> <out.md>

Every message tree whose root system prompt belongs to the chosen agent is
emitted in creation order, deduplicated by message id, so compaction copies
appear once and abandoned branches are kept in chronological position.

Keeps user prompts, assistant replies, and tool calls/results (truncated).
Drops system messages, injected environment/rule/skill/guidance blocks, model
metadata, and thinking. Redacts the home directory and credential-shaped strings.
"""

import json
import os
import re
import sqlite3
import sys

DB = os.path.expanduser("~/.local/share/devin/cli/sessions.db")
HOME = os.path.expanduser("~")
TOOL_ARGS_LIMIT = 2000
TOOL_RESULT_LIMIT = 1200
INJECTED = re.compile(
    r"<(system_info|rules|available_skills|additional_metadata|system_guidance|system-reminder)\b.*?</\1>",
    re.S,
)
SECRETS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._-]{16,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret)(\"?\s*[:=]\s*\"?)[A-Za-z0-9._-]{16,}"),
]


def redact(text):
    text = text.replace(HOME, "~")
    text = re.sub(r"/Users/[A-Za-z0-9._-]+", "~", text)
    text = re.sub(r"(?i)C:\\+Users\\+[A-Za-z0-9._-]+", "%USERPROFILE%", text)
    for pattern in SECRETS:
        text = pattern.sub(lambda m: (m.group(1) + m.group(2) if m.lastindex == 2 else "") + "[REDACTED]", text)
    return text


def clip(text, limit):
    return text if len(text) <= limit else text[:limit] + f"\n… [truncated {len(text) - limit} chars]"


ROOT_PREFIX = {
    "lead": "You are Devin, an interactive",
    "sidekick": "You are the Sidekick subagent",
    "subagents": "You are a general-purpose agent",
}


def history(db, session, kind):
    rows = db.execute(
        "select node_id, parent_node_id, chat_message from message_nodes where session_id=? order by node_id",
        (session,),
    ).fetchall()
    parent = {node: up for node, up, _ in rows}
    messages = {node: json.loads(raw) for node, _, raw in rows}

    def root(node):
        while parent[node] is not None:
            node = parent[node]
        return node

    def selected(node):
        content = messages[root(node)].get("content")
        return isinstance(content, str) and content.startswith(ROOT_PREFIX[kind])

    seen, out = set(), []
    for node, _, _ in rows:
        message = messages[node]
        key = message.get("message_id")
        if key in seen or not selected(node):
            continue
        seen.add(key)
        out.append(message)
    return out


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    return ""


def render(messages):
    lines = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        content = text_of(message.get("content"))
        if role == "user":
            content = INJECTED.sub("", content).strip()
            if content:
                lines += ["", "## User", "", content]
        elif role == "assistant":
            if content.strip():
                lines += ["", "### Assistant", "", content.strip()]
            for call in message.get("tool_calls") or []:
                args = json.dumps(call.get("arguments"), ensure_ascii=False, indent=1)
                lines += ["", f"<details><summary>tool call: {call.get('name')}</summary>", "", "```json",
                          clip(args.replace("```", "ˋˋˋ"), TOOL_ARGS_LIMIT), "```", "", "</details>"]
        elif role == "tool":
            lines += ["", "<details><summary>tool result</summary>", "", "```text",
                      clip(content.replace("```", "ˋˋˋ"), TOOL_RESULT_LIMIT), "```", "", "</details>"]
    return redact("\n".join(lines).strip() + "\n")


if __name__ == "__main__":
    session, kind, out = sys.argv[1], sys.argv[2], sys.argv[3]
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as db:
        messages = history(db, session, kind)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(f"# Session `{session}`: {kind} transcript\n\n{len(messages)} unique messages before filtering.\n\n")
        fh.write(render(messages))
    print(out, len(messages))
