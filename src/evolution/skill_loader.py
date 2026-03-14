"""Dynamic skill loader for .skill.py files, matching TS evolution/skill-loader.ts."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from src.tools.registry import register_tool
from src.types import ToolDefinition, ToolHandler
from src.utils.logger import create_logger

log = create_logger("evolution:skills")


class SkillLoader:
    def __init__(self, skills_dir: str = "user-space/skills") -> None:
        self._dir = Path(skills_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._skills: dict[str, ToolHandler] = {}  # name → handler
        self._catalog: list[dict] = []  # [{name, description}]
        self._load_gen = 0

    async def load_all(self) -> None:
        self._load_gen += 1
        self._catalog.clear()
        for path in sorted(self._dir.glob("*.skill.py")):
            try:
                handler = self._load_one(path)
                if handler:
                    self._skills[handler.definition.name] = handler
                    self._catalog.append({
                        "name": handler.definition.name,
                        "description": handler.definition.description,
                    })
            except Exception as e:
                log.warn("Failed to load skill", {"file": path.name, "error": str(e)})

    def get_catalog(self) -> list[dict]:
        return list(self._catalog)

    async def execute_skill(self, name: str, args: dict) -> str:
        prefixed = f"skill_{name}" if not name.startswith("skill_") else name
        handler = self._skills.get(prefixed)
        if not handler:
            available = ", ".join(self._skills.keys()) or "(none)"
            raise ValueError(f"Skill '{name}' not found. Available: {available}")
        return await handler.execute(args)

    async def hot_reload(self, filename: str) -> ToolHandler | None:
        path = self._dir / filename
        if not path.exists():
            return None
        self._load_gen += 1
        handler = self._load_one(path)
        if handler:
            self._skills[handler.definition.name] = handler
            self._catalog = [
                c for c in self._catalog if c["name"] != handler.definition.name
            ]
            self._catalog.append({
                "name": handler.definition.name,
                "description": handler.definition.description,
            })
        return handler

    async def create_skill(self, filename: str, source_code: str, overwrite: bool = False) -> str:
        if not filename.endswith(".skill.py"):
            filename += ".skill.py"
        path = self._dir / filename
        if path.exists() and not overwrite:
            raise FileExistsError(f"Skill file already exists: {filename}. Use overwrite=True.")
        path.write_text(source_code, encoding="utf-8")
        return str(path)

    def list_skill_files(self) -> list[str]:
        return [p.name for p in sorted(self._dir.glob("*.skill.py"))]

    def _load_one(self, path: Path) -> ToolHandler | None:
        module_name = f"core_skill_{path.stem}_{self._load_gen}"

        # Remove from sys.modules for hot-reload
        if module_name in sys.modules:
            del sys.modules[module_name]

        spec = importlib.util.spec_from_file_location(module_name, str(path))
        if not spec or not spec.loader:
            log.warn("Cannot load skill module", {"path": str(path)})
            return None

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        # Expect either module-level `skill` dict + `execute` function,
        # or a default export object with {name, description, parameters, execute}
        skill_meta = getattr(module, "skill", None)
        execute_fn = getattr(module, "execute", None)

        if not skill_meta or not execute_fn:
            log.warn("Skill missing 'skill' dict or 'execute' function", {"path": str(path)})
            return None

        name = f"skill_{skill_meta['name']}"
        definition = ToolDefinition(
            name=name,
            description=skill_meta.get("description", ""),
            parameters=skill_meta.get("parameters", {"type": "object", "properties": {}}),
        )

        handler = ToolHandler(definition=definition, execute=execute_fn)
        register_tool(handler)
        log.info("Skill loaded", {"name": name, "file": path.name})
        return handler


_loader: SkillLoader | None = None


def get_skill_loader() -> SkillLoader:
    global _loader
    if _loader is None:
        _loader = SkillLoader()
    return _loader
