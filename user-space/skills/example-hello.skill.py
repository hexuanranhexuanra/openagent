"""Example skill: demonstrates the skill script format.

Skills are dynamically loaded at startup and can be hot-reloaded.
The agent can create new skills via the skill_create tool.

File naming: must end with .skill.py
Required: module-level `skill` dict + async `execute` function.
"""

from datetime import datetime

skill = {
    "name": "hello",
    "description": "A simple greeting skill that demonstrates the skill format",
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Name to greet",
            },
        },
        "required": ["name"],
    },
}


async def execute(args: dict) -> str:
    name = args.get("name", "World")
    now = datetime.now().strftime("%H:%M:%S")
    return (
        f'{{"greeting": "你好 {name}！现在是 {now}", '
        f'"tip": "这是一个示例技能，你可以通过 skill_create 工具创建更多技能。"}}'
    )
