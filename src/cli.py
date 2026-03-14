"""CLI entry point — matches TS CLI commands."""

import asyncio
import sys
from typing import Optional

import typer

app = typer.Typer(name="openagent", help="OpenAgent — self-evolving AI assistant")


@app.command()
def gateway(
    port: Optional[int] = typer.Option(None, help="Override gateway port"),
    host: Optional[str] = typer.Option(None, help="Override gateway host"),
) -> None:
    """Start HTTP + WebSocket gateway server."""
    import uvicorn
    from src.config import load_config

    config = load_config()
    final_host = host or config.gateway.host or "127.0.0.1"
    final_port = port or config.gateway.port or 19090

    typer.echo(f"Starting OpenAgent gateway on {final_host}:{final_port}")
    uvicorn.run(
        "src.gateway.app:create_app",
        factory=True,
        host=final_host,
        port=final_port,
        log_level="info",
    )


@app.command()
def chat(verbose: bool = typer.Option(False, help="Show tool call details")) -> None:
    """Interactive REPL chat."""
    asyncio.run(_chat_loop(verbose))


async def _chat_loop(verbose: bool) -> None:
    from src.config import load_config
    load_config()

    from src.sessions.manager import init_db
    await init_db()

    from src.agents.init import init_agent, run_agent
    await init_agent()

    peer_id = "cli:repl"
    typer.echo("OpenAgent REPL — type 'exit' to quit\n")

    while True:
        try:
            user_input = input("You> ").strip()
        except (EOFError, KeyboardInterrupt):
            typer.echo("\nBye!")
            break

        if not user_input:
            continue
        if user_input.lower() in ("exit", "quit", "/exit", "/quit"):
            typer.echo("Bye!")
            break

        response_parts: list[str] = []
        async for event in run_agent("cli", peer_id, user_input):
            if event.type == "text" and event.content:
                sys.stdout.write(event.content)
                sys.stdout.flush()
                response_parts.append(event.content)
            elif event.type == "tool_start" and verbose:
                typer.echo(f"\n  [tool] {event.tool_name}({event.tool_args})")
            elif event.type == "tool_end" and verbose:
                result_preview = (event.tool_result or "")[:200]
                typer.echo(f"  [result] {result_preview}")
            elif event.type == "error":
                typer.echo(f"\n[ERROR] {event.error}", err=True)

        if response_parts:
            sys.stdout.write("\n\n")
            sys.stdout.flush()


@app.command()
def agent(message: str = typer.Option(..., "-m", help="Message to send")) -> None:
    """One-shot message."""
    asyncio.run(_one_shot(message))


async def _one_shot(message: str) -> None:
    from src.config import load_config
    load_config()

    from src.sessions.manager import init_db
    await init_db()

    from src.agents.init import init_agent, run_agent
    await init_agent()

    async for event in run_agent("cli", "cli:oneshot", message):
        if event.type == "text" and event.content:
            sys.stdout.write(event.content)
            sys.stdout.flush()
        elif event.type == "error":
            typer.echo(f"\n[ERROR] {event.error}", err=True)
            raise typer.Exit(1)

    sys.stdout.write("\n")
    sys.stdout.flush()


@app.command()
def status() -> None:
    """Show server status."""
    import httpx
    from src.config import load_config

    config = load_config()
    base = f"http://{config.gateway.host}:{config.gateway.port}"
    headers = {}
    if config.gateway.auth_token:
        headers["Authorization"] = f"Bearer {config.gateway.auth_token}"

    try:
        resp = httpx.get(f"{base}/api/status", headers=headers, timeout=5)
        data = resp.json()
        typer.echo(f"Version:  {data.get('version', '?')}")
        typer.echo(f"Runtime:  {data.get('runtime', '?')}")
        typer.echo(f"PID:      {data.get('pid', '?')}")
        typer.echo(f"Memory:   {data.get('memoryMB', '?')} MB")
        typer.echo(f"Uptime:   {data.get('uptime', 0):.0f}s")
    except Exception as e:
        typer.echo(f"Cannot reach gateway: {e}", err=True)
        raise typer.Exit(1)


@app.command()
def doctor() -> None:
    """Check configuration and system health."""
    from src.config import load_config

    checks: list[tuple[str, bool, str]] = []

    try:
        config = load_config()
        checks.append(("Config", True, f"provider={config.agent.default_provider}"))
    except Exception as e:
        typer.echo(f"Config error: {e}", err=True)
        raise typer.Exit(1)

    checks.append(("Gateway", True, f"{config.gateway.host}:{config.gateway.port}"))
    checks.append(("DB path", True, config.storage.db_path))

    oai = config.providers.openai
    ant = config.providers.anthropic

    if ant.api_key or ant.setup_token:
        checks.append(("Anthropic", True, f"model={ant.model}"))
    elif oai.api_key:
        checks.append(("OpenAI", True, f"model={oai.model}"))
    else:
        checks.append(("LLM Provider", False, "No API key configured"))

    feishu = config.channels.feishu
    if feishu.app_id and feishu.app_secret:
        checks.append(("Feishu", True, f"app_id={feishu.app_id[:8]}..."))
    else:
        checks.append(("Feishu", False, "Not configured (optional)"))

    from pathlib import Path
    for name in ("SOUL", "USER", "WORLD"):
        p = Path(f"user-space/memory/{name}.md")
        if p.exists():
            size = len(p.read_text(encoding="utf-8"))
            checks.append((f"Memory/{name}", True, f"{size} chars"))
        else:
            checks.append((f"Memory/{name}", False, "Missing"))

    typer.echo("OpenAgent Doctor\n")
    for name, ok, detail in checks:
        mark = "OK" if ok else "--"
        typer.echo(f"  [{mark}] {name}: {detail}")

    typer.echo("")


if __name__ == "__main__":
    app()
