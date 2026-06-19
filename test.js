const params = new URLSearchParams({
    q: "nodejs",
    format: "json"
});

const res = await fetch(`http://localhost:8080/search?${params}`);
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

console.log('formatted results', formattedResults);