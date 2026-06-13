import { initDb, getMessages, getConversations } from "./modules/db.js";

await initDb();

const convs = await getConversations();
console.log(convs)

const messages = await getMessages(41)
console.log(messages)