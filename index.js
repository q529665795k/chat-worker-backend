// 绑定：KV=bbb D1=MY_MMM DO=ChatDO 前端=nnn
const KEEP_ALIVE_EXPIRE = 24 * 60 * 60 * 1000;
const KEEP_ALIVE_CHECK_INTERVAL = 60 * 1000;
const UNLOGGED_CLEAN_INTERVAL = 180000;
const REDIS_EXPIRE = 7200;
const MATCH_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 45000;
const HEARTBEAT_TIMEOUT = 60000;

export class ChatDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.userMap = new Map();
    this.loginMap = new Map();
    this.userSessionMap = new Map();
    this.keepAliveMap = new Map();
    this.userMatchTimer = new Map();
    this.roomMem = new Map();
    this.offlineMsgMem = new Map();
    console.log("DO 初始化完成");
  }

  async dbQuery(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.all();
    } catch (e) {
      return { results: [] };
    }
  }

  async dbRun(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.run();
    } catch (e) {
      return null;
    }
  }

  sysLog(tag, msg, data = {}) {
    const t = new Date().toLocaleString('zh-CN');
    console.log(`[${t}] ${tag}：${msg}`, data);
  }

  async callAI(prompt) {
    try {
      const res = await fetch("https://useavnmd-mm.hf.space/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen2:0.5b",
          messages: [{ role: "user", content: prompt }],
          stream: false
        }),
        signal: AbortSignal.timeout(15000)
      });
      const json = await res.json();
      return json.message?.content || "爸爸～在呢";
    } catch (e) {
      return "爸爸～我掉线了";
    }
  }

  async initDB() {
    try {
      await this.dbRun(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,nickname TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
      await this.dbRun(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,sender TEXT NOT NULL,receiver TEXT NOT NULL,content TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    } catch (err) {}
  }

  async loadUsers() {
    try {
      const res = await this.dbQuery('SELECT username,nickname,password FROM users');
      this.loginMap.clear();
      res.results.forEach(u => this.loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password }));
    } catch (e) {}
  }

  cleanMatchTimer(uid) {
    try {
      if (this.userMatchTimer.has(uid)) {
        clearTimeout(this.userMatchTimer.get(uid));
        this.userMatchTimer.delete(uid);
      }
    } catch (e) {}
  }

  stopChat(uid, isInitiative = true) {
    try {
      const me = this.userMap.get(uid);
      if (!me || !me.partner) return;
      this.cleanMatchTimer(uid);
      if (me.partner !== "ai_bot") {
        const pt = this.userMap.get(me.partner);
        if (pt && pt.socket) {
          pt.partner = null;
          pt.isMatched = false;
          pt.socket.send(JSON.stringify({ type: 'partner-leave' }));
        }
      }
      me.partner = null;
      me.isMatched = false;
      me.socket.send(JSON.stringify({ type: 'match-end', data: { info: isInitiative ? '已断开' : '结束' } }));
      this.keepAliveMap.delete(uid);
    } catch (e) {}
  }

  assignAiRobot(sid) {
    try {
      const u = this.userMap.get(sid);
      if (!u || !u.socket || u.isMatched) return;
      this.cleanMatchTimer(sid);
      u.partner = "ai_bot";
      u.isMatched = true;
      u.socket.send(JSON.stringify({ type: 'match-found', data: { partnerName: "AI陪伴者" } }));
    } catch (e) {}
  }

  async globalMatch(env, ctx, sid) {
    try {
      const user = this.userMap.get(sid);
      if (!user || !user.username) return;
      let waitRaw = null;
      try { waitRaw = await env.bbb.get("global_match_wait"); } catch(e){}
      if (waitRaw) {
        const waitUser = JSON.parse(waitRaw);
        const targetUser = this.userMap.get(waitUser.sid);
        if (targetUser && targetUser.username) {
          try { ctx.waitUntil(env.bbb.delete("global_match_wait")); } catch(e){}
          this.cleanMatchTimer(sid);
          this.cleanMatchTimer(waitUser.sid);
          user.partner = waitUser.sid;
          targetUser.partner = sid;
          user.isMatched = true;
          targetUser.isMatched = true;
          user.socket.send(JSON.stringify({ type: "match-found", data: { partnerName: targetUser.username } }));
          targetUser.socket.send(JSON.stringify({ type: "match-found", data: { partnerName: user.username } }));
          return;
        }
      }
      try {
        ctx.waitUntil(env.bbb.put("global_match_wait", JSON.stringify({ sid, username: user.username })));
      } catch(e){}
      const timer = setTimeout(async () => {
        try {
          let w = await env.bbb.get("global_match_wait");
          if (w && JSON.parse(w).sid === sid) {
            ctx.waitUntil(env.bbb.delete("global_match_wait"));
            this.assignAiRobot(sid);
          }
        } catch(e){}
      }, MATCH_TIMEOUT);
      this.userMatchTimer.set(sid, timer);
    } catch (e) {}
  }

  startKeepAliveCheck() {
    setInterval(() => {
      try {
        const now = Date.now();
        this.keepAliveMap.forEach((val, uid) => {
          const u = this.userMap.get(uid);
          const p = this.userMap.get(val.partnerId);
          if (!u || !p || now - u.lastKeepAlive > HEARTBEAT_TIMEOUT) {
            this.keepAliveMap.delete(uid);
            this.keepAliveMap.delete(val.partnerId);
            this.stopChat(uid, false);
            this.stopChat(val.partnerId, false);
          }
        });
      } catch (e) {}
    }, KEEP_ALIVE_CHECK_INTERVAL);
  }

  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('origin') || "";
      const corsHeaders = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Credentials": "true"
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      await this.initDB();
      await this.loadUsers();

      if (url.pathname.startsWith("/socket.io")) {
        const upgrade = request.headers.get("Upgrade");
        if (!upgrade || upgrade !== "websocket") return new Response("Need WebSocket", { status: 400 });
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        const sid = Math.random().toString(36).slice(2);
        const user = { id: sid, socket: server, username: "", partner: null, isMatched: false, lastKeepAlive: Date.now() };
        this.userMap.set(sid, user);

        const heartBeat = setInterval(() => {
          try { server.send(JSON.stringify({ type: "ping" })); } catch (e) { clearInterval(heartBeat); }
        }, HEARTBEAT_INTERVAL);

        const unloginTimer = setInterval(() => {
          try {
            if (!this.userMap.has(sid)) { clearInterval(unloginTimer); clearInterval(heartBeat); return; }
            if (!user.username) {
              server.close();
              this.userMap.delete(sid);
              clearInterval(unloginTimer);
              clearInterval(heartBeat);
            }
          } catch (e) {}
        }, UNLOGGED_CLEAN_INTERVAL);

        server.addEventListener("message", async (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "ping") { server.send(JSON.stringify({ type: "pong" })); return; }
            if (data.type === "pong") { user.lastKeepAlive = Date.now(); return; }
            if (data.type === "user-online") { user.username = data.username; return; }
            if (data.type === "match-chat") await this.globalMatch(env, ctx, sid);
            if (data.type === "stop-chat") this.stopChat(sid, true);
            if (data.type === "send-msg") {
              const to = this.userMap.get(user.partner);
              if (to && to.socket) {
                await this.dbRun("INSERT INTO messages (sender,receiver,content) VALUES (?,?,?)", [user.username, to.username, data.data.content]);
                to.socket.send(JSON.stringify({ type: "new-msg", data: { content: data.data.content, fromName: user.username } }));
              }
            }
          } catch (e) {}
        });

        server.addEventListener("close", async () => {
          try {
            this.cleanMatchTimer(sid);
            this.userMap.delete(sid);
            clearInterval(heartBeat);
            clearInterval(unloginTimer);
          } catch (e) {}
        });

        return new Response(null, { status: 101, webSocket: client });
      }

      return new Response("Service running", { headers: corsHeaders });
    } catch (e) {
      return new Response("Server error", { status: 500 });
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      // 已删除：/upload → env.cvvv
      if (url.pathname.startsWith("/api")) return env.nnn.fetch(request);

      const obj = env.ChatDO.get(env.ChatDO.idFromName("global-chat"), { locationHint: "apac" });
      return obj.fetch(request, env, ctx);
    } catch (e) {
      return new Response("Busy", { status: 503 });
    }
  }
};
