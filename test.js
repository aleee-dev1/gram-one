import { initDb, getConversations, getConversation, getMessages } from "./modules/db.js";

await initDb();

const convs = await getConversations();
// console.log(convs[0]);
const msgs = await getMessages(1);

for (let msg of msgs) {
    const emb = msg.embedding
    let sum = 0;
    for (let e = 0; e < emb.length; e++) {
        sum += emb[e];
    }
    console.log(sum)
}