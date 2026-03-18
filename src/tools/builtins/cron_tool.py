"""Cron job management tool, matching TS tools/builtin/cron-tool.ts."""

from __future__ import annotations

import json

from src.types import ToolDefinition, ToolHandler


async def _execute(args: dict) -> str:
    from src.background.cron import get_cron_service

    action = args.get("action", "")
    service = get_cron_service()

    if action == "add":
        name = args.get("name")
        cron_expr = args.get("cron_expr")
        task = args.get("task")
        target_channel = args.get("target_channel", "webchat")
        target_peer = args.get("target_peer", "broadcast")

        if not all([name, cron_expr, task]):
            return json.dumps({"error": "add requires name, cron_expr, and task"})

        job = service.add_job(
            name=name,
            cron_expr=cron_expr,
            task=task,
            target_channel=target_channel,
            target_peer=target_peer,
        )
        return json.dumps({"added": True, "job": job})

    elif action == "remove":
        job_id = args.get("job_id")
        if not job_id:
            return json.dumps({"error": "remove requires job_id"})
        removed = service.remove_job(job_id)
        return json.dumps({"removed": removed, "jobId": job_id})

    elif action == "list":
        jobs = service.list_jobs()
        return json.dumps({"jobs": jobs, "count": len(jobs)})

    elif action == "trigger":
        job_id = args.get("job_id")
        if not job_id:
            return json.dumps({"error": "trigger requires job_id"})
        triggered = await service.trigger_now(job_id)
        return json.dumps({"triggered": triggered, "jobId": job_id})

    else:
        return json.dumps({"error": f"Unknown action: {action}. Use add, remove, list, or trigger."})


cron_tool = ToolHandler(
    definition=ToolDefinition(
        name="cron",
        description="Manage scheduled agent tasks. Actions: add, remove, list, trigger.",
        parameters={
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "Action: add, remove, list, trigger"},
                "name": {"type": "string", "description": "[add] Job name"},
                "cron_expr": {"type": "string", "description": "[add] 5-field cron: 'min hour dom month dow'"},
                "task": {"type": "string", "description": "[add] Natural language instruction"},
                "target_channel": {"type": "string", "description": "[add] Target: webchat or feishu (default: webchat)"},
                "target_peer": {"type": "string", "description": "[add] Target peer ID"},
                "job_id": {"type": "string", "description": "[remove, trigger] Job ID"},
            },
            "required": ["action"],
        },
    ),
    execute=_execute,
)
