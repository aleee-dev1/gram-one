import axios from "axios";
import * as cheerio from "cheerio";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_BASE = "https://api.tavily.com";

export async function searchKeywords(keywords, maxResults = 10) {

    if (!keywords || typeof keywords !== "string") {
        throw new Error("keywords must be a string");
    }

    if (maxResults < 1 || maxResults > 10) {
        throw new Error("maxResults must be between 1 and 10");
    }

    let results = await searXNG(keywords);

    if(results.length === 0) {
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

async function searXNG(keywords) {

    const res = await fetch(`http://localhost:8080/search?q=${encodeURIComponent(keywords)}&format=json`);

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
            score: +res.score.toFixed(2)
        })
    }
    
    return formattedResults;
}

export async function scrape(url) {
    
    const res = await fetch(`${TAVILY_BASE}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            api_key: TAVILY_API_KEY,
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

