export default {
  name: "tavily-search",
  description: "Search the web using Tavily",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "number", description: "Max results", default: 5 },
      search_depth: { type: "string", description: "basic or advanced", default: "basic" },
      include_answer: { type: "boolean", description: "Include Tavily answer", default: false },
      include_raw_content: { type: "boolean", description: "Include raw content", default: false }
    },
    required: ["query"]
  },
  async execute({ query, max_results = 5, search_depth = "basic", include_answer = false, include_raw_content = false }) {
    const apiKey = "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";
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results,
        search_depth,
        include_answer,
        include_raw_content
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tavily error ${res.status}: ${text}`);
    }
    return await res.json();
  }
};
