"""Score fusion-prototype trials: lead + sidekick USD cost at list price, wall time, reward.

Usage: python score_fusion.py <harbor-job-dir> [...] > fusion.csv

Per trial it expects (same layout as bench-delegation-value):
  agent/pi/sessions/*.jsonl          lead (main) session, collected by Harbor
  agent/pi-extra/sessions/**/*.jsonl copy of $PI_CODING_AGENT_DIR/sessions after the run
  verifier/reward.txt, result.json
Every pi-extra session whose header id differs from the main session's id is a child.

Cost is computed here from token counts, never from Pi's usage.cost (the Harbor
endpoint reports 0). Each assistant message is priced by its own `model` field,
so a child that resolved to an unexpected model shows up in `models` and makes
cost_complete False. Prices are USD per million tokens, copied from Pi 1.3.0's
built-in model table (pi-coding-agent dist/bundle/chunks/chunk-66G7ITPS.js):
  gpt-6.1-sol    input 2, output 10, cacheRead 0.1, cacheWrite 2.5;
                 tier when a request's input side (input+cacheRead+cacheWrite)
                 exceeds 272k: input 4, output 15, cacheRead 0.2, cacheWrite 5
  deepseek-flash input 0.3, output 1.2, cacheRead 0.006, cacheWrite 0
Pi's `output` already includes reasoning tokens for both APIs; do not add `reasoning`.
"""
import csv, glob, json, os, sys
from datetime import datetime

PRICES = {
    "gpt-6.1-sol": {
        "base": {"input": 2.0, "output": 10.0, "cacheRead": 0.1, "cacheWrite": 2.5},
        "tier_above": 272_000,
        "tier": {"input": 4.0, "output": 15.0, "cacheRead": 0.2, "cacheWrite": 5.0},
    },
    "deepseek-flash": {
        "base": {"input": 0.3, "output": 1.2, "cacheRead": 0.006, "cacheWrite": 0.0},
    },
}


def header_id(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return (json.loads(fh.readline() or "{}")).get("id")


def message_cost(model, x):
    p = PRICES.get(model)
    if p is None:
        return None
    ctx = (x.get("input") or 0) + (x.get("cacheRead") or 0) + (x.get("cacheWrite") or 0)
    rate = p["tier"] if "tier" in p and ctx > p["tier_above"] else p["base"]
    return sum((x.get(k) or 0) * rate[k] for k in rate) / 1e6


def usage(path):
    u = dict(turns=0, cum_in=0, cum_cache=0, cum_out=0, usd=0.0, unpriced=0,
             models=set(), spawn=0, spawn_sidekick=0, send=0, wait=0, workflow=0)
    for line in open(path, encoding="utf-8", errors="replace"):
        e = json.loads(line)
        m = e.get("message") or {}
        if e.get("type") != "message" or m.get("role") != "assistant":
            continue
        x = m.get("usage") or {}
        model = m.get("model") or "?"
        u["models"].add(model)
        u["turns"] += 1
        u["cum_in"] += (x.get("input") or 0) + (x.get("cacheRead") or 0) + (x.get("cacheWrite") or 0)
        u["cum_cache"] += x.get("cacheRead") or 0
        u["cum_out"] += x.get("output") or 0
        c = message_cost(model, x)
        if c is None:
            u["unpriced"] += 1
        else:
            u["usd"] += c
        for part in m.get("content") or []:
            if part.get("type") != "toolCall":
                continue
            name = part.get("name")
            u["spawn"] += name == "subagent_spawn"
            u["spawn_sidekick"] += name == "subagent_spawn" and (part.get("arguments") or {}).get("agent_type") == "sidekick"
            u["send"] += name == "subagent_send"
            u["wait"] += name == "subagent_wait"
            u["workflow"] += name == "workflow"
    return u


def seconds(span):
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return round((f(span["finished_at"]) - f(span["started_at"])).total_seconds(), 1)


writer = None
for root in sys.argv[1:]:
    for trial in sorted(glob.glob(os.path.join(root, "*", "agent"))):
        tdir = os.path.dirname(trial)
        mains = sorted(glob.glob(os.path.join(trial, "pi", "sessions", "*.jsonl")))
        if not mains:
            continue
        main = mains[0]
        main_id = header_id(main)
        extra = glob.glob(os.path.join(trial, "pi-extra", "sessions", "**", "*.jsonl"), recursive=True)
        children = [f for f in extra if header_id(f) != main_id]
        lead = usage(main)
        kid = dict(turns=0, cum_in=0, cum_cache=0, cum_out=0, usd=0.0, unpriced=0, models=set())
        for f in children:
            c = usage(f)
            for k in ("turns", "cum_in", "cum_cache", "cum_out", "usd", "unpriced"):
                kid[k] += c[k]
            kid["models"] |= c["models"]
        result = json.load(open(os.path.join(tdir, "result.json")))
        reward_path = os.path.join(tdir, "verifier", "reward.txt")
        row = {
            "job": os.path.basename(root), "trial": os.path.basename(tdir),
            "reward": open(reward_path).read().strip() if os.path.exists(reward_path) else "",
            "wall_s": seconds(result["agent_execution"]) if result.get("agent_execution") else "",
            "lead_models": "|".join(sorted(lead["models"])),
            "child_models": "|".join(sorted(kid["models"])),
            "lead_turns": lead["turns"], "lead_in": lead["cum_in"], "lead_cache": lead["cum_cache"], "lead_out": lead["cum_out"],
            "spawn": lead["spawn"], "spawn_sidekick": lead["spawn_sidekick"], "send": lead["send"], "wait": lead["wait"],
            "workflow": lead["workflow"], "child_sessions": len(children),
            "child_turns": kid["turns"], "child_in": kid["cum_in"], "child_cache": kid["cum_cache"], "child_out": kid["cum_out"],
            "lead_usd": round(lead["usd"], 4), "child_usd": round(kid["usd"], 4),
            "total_usd": round(lead["usd"] + kid["usd"], 4),
            "cost_complete": (lead["unpriced"] + kid["unpriced"] == 0 and lead["workflow"] == 0
                              and (lead["spawn"] == 0 or len(children) >= lead["spawn"])),
        }
        if writer is None:
            writer = csv.DictWriter(sys.stdout, fieldnames=list(row))
            writer.writeheader()
        writer.writerow(row)
