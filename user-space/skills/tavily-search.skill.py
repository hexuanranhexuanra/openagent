"""Tavily web search skill — real-time web search via Tavily API."""

import json
import os

skill = {
    "name": "tavily-search",
    "description": "Search the web using Tavily API for real-time information",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query to find information about",
            },
            "max_results": {
                "type": "number",
                "description": "Maximum number of results to return (1-20)",
                "default": 5,
            },
            "search_depth": {
                "type": "string",
                "description": "Search depth: 'basic' for quick or 'advanced' for comprehensive",
                "enum": ["basic", "advanced"],
                "default": "basic",
            },
            "include_answer": {
                "type": "boolean",
                "description": "Include Tavily's AI-generated answer summary",
                "default": False,
            },
        },
        "required": ["query"],
    },
}


async def execute(args: dict) -> str:
    import httpx

    query = (args.get("query") or "").strip()
    if not query:
        raise ValueError("Search query cannot be empty")

    api_key = os.environ.get("TAVILY_API_KEY", "")
    if not api_key:
        raise ValueError("TAVILY_API_KEY environment variable not set")

    max_results = max(1, min(int(args.get("max_results", 5)), 20))

    payload = {
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "search_depth": args.get("search_depth", "basic"),
        "include_answer": args.get("include_answer", False),
        "include_raw_content": False,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.tavily.com/search",
            json=payload,
            headers={"Content-Type": "application/json", "User-Agent": "OpenAgent/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()

    results = [
        {
            "rank": i + 1,
            "title": r.get("title", ""),
            "url": r.get("url", ""),
            "content": r.get("content", ""),
            "score": round(r.get("score", 0), 2),
        }
        for i, r in enumerate(data.get("results", []))
    ]

    return json.dumps({
        "query": data.get("query", query),
        "answer": data.get("answer"),
        "results": results,
        "total_results": len(results),
        "response_time": data.get("response_time"),
    }, ensure_ascii=False)
