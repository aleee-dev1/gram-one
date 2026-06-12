import { initDb, getAllFacts } from "./modules/db.js";

await initDb();

const facts = await getAllFacts();
console.log(facts)