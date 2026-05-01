// 绑定：KV=bbb D1=MY_MMM DO=ChatDO 前端=nnn R2=cvvv
const KEEP_ALIVE_EXPIRE = 86400000;
const KEEP_ALIVE_CHECK_INTERVAL = 60000;
const UNLOGGED_CLEAN_INTERVAL = 180000;
const MATCH_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 45000;
const HEARTBEAT_TIMEOUT = 60000;

// ✅ 顶层导出ChatDO（官方强制，不硬写任何ID）
export class ChatDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.userMap = new Map();
    this.loginMap = new Map();
    this.userMatchTimer = new Map();
    // ✅ 耗时初始化全丢后台，不卡请求
    this.initBackground();
  }

  // ✅ 后台异步初始化，不占用请求超时时间！！
  async initBackground() {
    try {
      await this.initDB();
      await this.loadUsers();
    } catch (e) {}
  }

  async dbQuery(sql, params = []) {
    try {
      return await this.env.MY_MMM.prepare(sql).bind(...params).all();
    } catch (e) { return { results: [] }; }
  }

  async dbRun(sql, params = []) {
    try {
      return await this.env.MY_MMM.prepare(sql).bind(...params).run();
    } catch (e) { return null; }
  }

  async initDB() {
    await this.dbRun(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,nickname TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await this.dbRun(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,sender TEXT NOT NULL,receiver TEXT NOT NULL,content TEXT,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  }

  async loadUsers() {
    const res = await this.dbQuery('SELECT username,nickname,password FROM users');
    this.loginMap.clear();
    res.results.forEach(u => this.loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password }));
  }

  cleanMatchTimer(uid) {
    if (this.userMatchTimer.has(uid)) {
      clearTimeout(this.userMatchTimer.get(uid));
      this.userMatchTimer.delete(uid);
    }
  }

  stopChat(uid, isInitiative = true) {
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
  }

  assignAiRobot(sid) {
    const u = this.userMap.get(sid);
    if (!u || !u.socket || u.isMatched) return;
    this.cleanMatchTimer(sid);
    u.partner = "ai_bot";
    u.isMatched = true;
    u.socket.send(JSON.stringify({ type: 'match-found', data: { partnerName: "AI陪伴者" } }));
  }

  async globalMatch(env, ctx, sid) {
    const user = this.userMap.get(sid);
    if (!user || !user.username) return;

    let waitRaw = null;
    try { waitRaw = await env.bbb.get("global_match_wait"); } catch(e){}

    if (waitRaw) {
      const waitUser = JSON.parse(waitRaw);
      const targetUser = this.userMap.get(waitUser.sid);
      if (targetUser && targetUser.username) {
        ctx.waitUntil(env.bbb.delete("global_match_wait"));
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

    ctx.waitUntil(env.bbb.put("global_match_wait", JSON.stringify({ sid, username: user.username })));
    const timer = setTimeout(async () => {
      let w = await env.bbb.get("global_match_wait");
      if (w && JSON.parse(w).sid === sid) {
        ctx.waitUntil(env.bbb.delete("global_match_wait"));
        this.assignAiRobot(sid);
      }
    }, MATCH_TIMEOUT);
    this.userMatchTimer.set(sid, timer);
  }

  // ✅ DO内部标准fetch，无硬编码ID
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    // ✅ WebSocket 处理（官方合规，无超时）
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
        if (!this.userMap.has(sid)) { clearInterval(unloginTimer); clearInterval(heartBeat); return; }
        if (!user.username) {
          server.close();
          this.userMap.delete(sid);
          clearInterval(unloginTimer);
          clearInterval(heartBeat);
        }
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
        this.cleanMatchTimer(sid);
        this.userMap.delete(sid);
        clearInterval(heartBeat);
        clearInterval(unloginTimer);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // ✅ 普通请求快速返回，绝不卡超时
    return new Response("运行正常", { headers: corsHeaders });
  }
}

// ✅ Worker入口：全动态生成DO实例，**无任何硬编码ID！！**
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/upload")) return env.cvvv.fetch(request);
    if (url.pathname.startsWith("/api")) return env.nnn.fetch(request);

    // ✅ 官方标准动态生成实例，Cloudflare自动管理ID
    const doInstance = env.ChatDO.get(env.ChatDO.idFromName("global-chat"));
    return doInstance.fetch(request, env, ctx);
  }
};
