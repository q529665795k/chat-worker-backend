const D1_BIND = "MY_MMM";
const KV_BIND = "bbb";
const DO_BIND = "ChatDO";

export class ChatDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.onlineClients = new Map(); // 格式：Map(ws连接, 昵称)
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws/chat") return this.handleWS(request);
    if (url.pathname === "/api/history") return this.getHistory();
    if (url.pathname === "/api/online") return this.getOnline();
    return new Response("404", { status: 404 });
  }

  async handleWS(request) {
    const [client, server] = new WebSocketPair();
    client.accept();
    const nick = new URL(request.url).searchParams.get("nick") || "匿名";
    this.onlineClients.set(client, nick);

    // 新用户上线 全员广播
    this.broadcast({ type: "system", text: `${nick} 进入摸鱼基地` });
    await this.updateOnline(1);

    // 接收消息
    client.addEventListener("message", async (e) => {
      const data = JSON.parse(e.data);
      await this.saveMsg(nick, data.content);
      // 全员广播聊天消息
      this.broadcast({
        type: "chat",
        nick: nick,
        content: data.content,
        time: new Date().toLocaleTimeString()
      });
    });

    // 用户下线 全员广播
    client.addEventListener("close", async () => {
      const leaveNick = this.onlineClients.get(client);
      this.onlineClients.delete(client);
      this.broadcast({ type: "system", text: `${leaveNick} 离开摸鱼基地` });
      await this.updateOnline(-1);
    });

    return new Response(null, { status: 101, webSocket: server });
  }

  // ✅ 【终极修复点】这里forEach顺序必须是 (ws, nick)！！！
  broadcast(data) {
    const msg = JSON.stringify(data);
    this.onlineClients.forEach((nick, ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
  }

  async saveMsg(nick, content) {
    await this.env[D1_BIND].prepare(`INSERT INTO chat_msg (user_nick, msg_content, create_time) VALUES (?, ?, ?)`).bind(nick, content, Date.now()).run();
  }

  async getHistory() {
    const res = await this.env[D1_BIND].prepare(`SELECT user_nick, msg_content FROM chat_msg ORDER BY create_time DESC LIMIT 50`).all();
    return new Response(JSON.stringify(res.results.reverse()), { headers: { "Content-Type": "application/json" } });
  }

  async updateOnline(change) {
    let count = Number(await this.env[KV_BIND].get("online")) || 0;
    await this.env[KV_BIND].put("online", String(Math.max(0, count + change)));
  }

  async getOnline() {
    const count = await this.env[KV_BIND].get("online") || "0";
    return new Response(JSON.stringify({ online: count }), { headers: { "Content-Type": "application/json" } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/api")) {
      const roomId = env[DO_BIND].idFromName("global");
      return env[DO_BIND].get(roomId).fetch(request);
    }
    return new Response(await getHtml(), { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }
};

async function getHtml() {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>摸鱼基地</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#fff;height:100vh;display:flex;flex-direction:column}
.header{padding:15px;text-align:center;background:#1e293b}
#chat{flex:1;padding:10px;overflow-y:auto}
.msg{margin:8px 0;padding:10px;border-radius:8px;max-width:85%}
.self{background:#2563eb;margin-left:auto}
.other{background:#334155;margin-right:auto}
.system{text-align:center;color:#94a3b8;font-size:13px;margin:10px 0}
.input{display:flex;padding:10px;background:#1e293b}
#txt{flex:1;padding:12px;border:none;border-radius:6px;background:#334155;color:#fff;outline:none}
#send{margin-left:10px;padding:0 15px;border:none;border-radius:6px;background:#2563eb;color:#fff}
</style>
</head>
<body>
  <div class="header">摸鱼基地 | 在线：<span id="num">0</span></div>
  <div id="chat"></div>
  <div class="input">
    <input id="txt" placeholder="发消息...">
    <button id="send">发送</button>
  </div>
<script>
const dom = window.location.host;
let nick = prompt("昵称：","摸鱼人")||"匿名";
const ws = new WebSocket(\`wss://\${dom}/ws/chat?nick=\${encodeURIComponent(nick)}\`);
const chat = document.getElementById("chat");
const txt = document.getElementById("txt");
const send = document.getElementById("send");

fetch("/api/history").then(r=>r.json()).then(list=>list.forEach(i=>add(i.user_nick,i.msg_content,false)));
setInterval(()=>fetch("/api/online").then(r=>r.json()).then(d=>document.getElementById("num").innerText=d.online),3000);

ws.onmessage = e=>{
  const d = JSON.parse(e.data);
  if(d.type==="system") chat.innerHTML+=\`<div class="system">\${d.text}</div>\`;
  if(d.type==="chat") add(d.nick,d.content,false);
  chat.scrollTop=chat.scrollHeight;
};

send.onclick = ()=>{
  const c = txt.value.trim();
  if(!c)return;
  ws.send(JSON.stringify({content:c}));
  add(nick,c,true);
  txt.value="";
};
txt.onkeydown=e=>e.key==="Enter"&&send.click();

function add(name,text,isSelf){
  chat.innerHTML+=\`<div class="msg \${isSelf?'self':'other'}"><div>\${name}</div><div>\${text}</div></div>\`;
  chat.scrollTop=chat.scrollHeight;
}
</script>
</body>
</html>
  `;
}
