export default {
  name: "tavily-search",
  description: "Search the web using Tavily API for real-time information",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to find information about"
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return",
        default: 5,
        minimum: 1,
        maximum: 20
      },
      search_depth: {
        type: "string",
        description: "Search depth: 'basic' for quick results or 'advanced' for comprehensive search",
        enum: ["basic", "advanced"],
        default: "basic"
      },
      include_answer: {
        type: "boolean",
        description: "Include Tavily's AI-generated answer summary",
        default: false
      },
      include_raw_content: {
        type: "boolean",
        description: "Include raw content from web pages",
        default: false
      }
    },
    required: ["query"]
  },

  async execute({ query, max_results = 5, search_depth = "basic", include_answer = false, include_raw_content = false }) {
    try {
      // Validate input
      if (!query || query.trim().length === 0) {
        throw new Error("Search query cannot be empty");
      }

      // Tavily API configuration
      const apiKey = "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";
      const apiUrl = "https://api.tavily.com/search";

      // Prepare request payload
      const payload = {
        api_key: apiKey,
        query: query.trim(),
        max_results: Math.min(Math.max(max_results, 1), 20), // Clamp between 1-20
        search_depth,
        include_answer,
        include_raw_content
      };

      console.log(`🔍 Searching for: "${query}" with ${max_results} results`);

      // Make API request
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "OpenAgent/1.0"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // Format response for better readability
      const formattedResults = {
        query: data.query,
        answer: data.answer,
        results: data.results?.map((result: any, index: number) => ({
          rank: index + 1,
          title: result.title,
          url: result.url,
          content: result.content,
          score: Math.round(result.score * 100) / 100,
          ...(include_raw_content && result.raw_content && { raw_content: result.raw_content })
        })) || [],
        response_time: data.response_time,
        total_results: data.results?.length || 0
      };

      console.log(`✅ Found ${formattedResults.total_results} results in ${data.response_time}s`);

      return formattedResults;

    } catch (error) {
      console.error("❌ Tavily search failed:", error);
      throw new Error(`Search failed: ${error.message}`);
    }
  }
};