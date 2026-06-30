import axios from "axios";
import * as cheerio from "cheerio";
import { getConfig } from "../../modules/db.js";

const TAVILY_BASE = "https://api.tavily.com";

export async function searchKeywords(keywords, maxResults = 10) {

    if (!keywords || typeof keywords !== "string") {
        throw new Error("keywords must be a string");
    }

    if (maxResults < 1 || maxResults > 10) {
        throw new Error("maxResults must be between 1 and 10");
    }

    const config = await getConfig();
    const searchEngine = config?.search_engine || "ddg";

    let results = [];

    if (searchEngine === "searxng") {
        try {
            results = await searXNG(keywords, config);
        } catch (err) {
            console.log("SearXNG failed, falling back to DDG", err);
            results = await rawSearch(keywords);
        }
    } else {
        results = await rawSearch(keywords);
    }

    return results.slice(0, maxResults);
}

async function rawSearch(keywords) {

    const AXIOS_CFG = {
        headers: {
            "User-Agent": "Mozilla/5.0"
        },
        timeout: 8000
    };

    const { data } = await axios.get(
        `https://duckduckgo.com/html/?q=${encodeURIComponent(keywords)}`,
        AXIOS_CFG
    );

    if (!data) {
        throw new Error("Could not get results from DuckDuckGo");
    }

    const $ = cheerio.load(data);
    const results = [];

    $(".result").each((_, el) => {
        const title = $(el).find(".result__a").text().trim();
        const rawHref = $(el).find(".result__a").attr("href");
        const description = $(el).find(".result__snippet").text().trim();

        let url = null;

        try {
            if (rawHref?.includes("uddg=")) {
                const u = new URL("https:" + rawHref);
                url = decodeURIComponent(u.searchParams.get("uddg"));
            }
        } catch { }

        if (title && url) {
            results.push({
                title,
                url,
                description
            });
        }
    });

    return results;
}

async function searXNG(keywords, config) {
    const baseUrl = config?.searxng_base_url || "http://localhost";
    const port = config?.searxng_port || "8080";

    let urlString = baseUrl;
    if (!urlString.startsWith("http")) urlString = "http://" + urlString;
    const url = new URL(urlString);
    if (port) url.port = port;
    url.pathname = "/search";
    url.search = `?q=${encodeURIComponent(keywords)}&format=json`;

    const res = await fetch(url.toString());

    if (!res.ok) {
        throw new Error(`SearXNG failed: ${res.status}`);
    }

    const data = await res.json();

    const rawResults = data.results;
    const formattedResults = [];

    for (let res of rawResults) {
        formattedResults.push({
            title: res.title,
            url: res.url,
            description: res.content,
            score: +(res.score || 0).toFixed(2)
        })
    }

    return formattedResults;
}

export async function scrape(url) {
    const config = await getConfig();
    const tavilyApiKey = config?.tavily_api_key || process.env.TAVILY_API_KEY;

    if (!tavilyApiKey) throw new Error("Tavily API key is not configured");

    const res = await fetch(`${TAVILY_BASE}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            api_key: tavilyApiKey,
            urls: [url],
            format: "text"
        })
    });

    if (!res.ok) throw new Error(`Tavily extract failed: ${res.status}`);

    const data = await res.json();
    const result = data.results?.[0];

    if (!result) throw new Error("No content extracted");

    return result.raw_content;
}
