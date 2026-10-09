import { WebSocketServer } from "ws";
import { WaveLinkClient } from "./plugin/service/core/wavelink.js";

const PORT = 45881;
const client = new WaveLinkClient();
client._discoverPort = async () => PORT;
client.on("error", () => {});
client.on("connected", () => console.log("  -> CONNECTE"));
client.on("disconnected", () => console.log("  -> deconnecte"));

try { await client.connect(); } catch (e) { console.log("1. echec initial :", e.message); }
const scheduled = [];
const realLog = console.log;

setTimeout(() => {
  const wss = new WebSocketServer({ port: PORT });
  wss.on("connection", (ws) => ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id !== undefined) ws.send(JSON.stringify({ id: m.id, jsonrpc: "2.0", result: {} }));
  }));
  realLog("2. Wave Link demarre");
}, 2500);

await new Promise((r) => setTimeout(r, 5000));
realLog("3. connected =", client.connected, "| tentatives de reprise =", client.reconnectAttempt);
realLog(client.connected ? "RESULTAT : reconnecte seul, backoff non doble" : "ECHEC");
client.disconnect();