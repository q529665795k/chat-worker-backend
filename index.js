// ====================== 【部署报错修复版｜类名ChatDO 100%匹配绑定】 ======================
// 绑定对应：耐用对象名称 = ChatDO（和你绑定里填的完全一致！！！）
// KV = bbb | D1 = MY_MMM | 前端 = nnn | 文件桶 = cvvv
const KEEP_ALIVE_EXPIRE = 24 * 60 * 60 * 1000;
const KEEP_ALIVE_CHECK_INTERVAL = 60 * 1000;
const UNLOGGED_CLEAN_INTERVAL = 180000;
const REDIS_EXPIRE = 7200;
const MATCH_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 45000;
const HEARTBEAT_TIMEOUT = 60000;

// 【强制！！！类名和你绑定里填的ChatDO完全一致】
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
    console.log("DO初始化完成，类名ChatDO与绑定完全匹配");
  }

  async dbQuery(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.all();
    } catch (e) {
      console.log("数据库查询失败：" + e.message);
      return { results: [] };
    }
  }
  async dbRun(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.run();
    } catch (e) {
      console.log("数据库执行失败：" + e.message);
      return null;
    }
  }

  sysLog(tag, msg, data = {}) {
    const t = new Date().toLocaleString('zh-CN');
    let logStr = "[" + t + "] " + tag + "：" + msg;
    if (Object.keys(data).length > 0) logStr += " 详情：" + JSON.stringify(data);
    console.log(logStr);
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
      console.log("AI对接失败：" + e.message);
      return "爸爸～我掉线了";
    }
  }

  async initDB() {
    try {
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      this.sysLog("数据库", "数据表初始化完成");
    } catch (err) {
      console.log("数据库初始化错误：" + err.message);
    }
  }

  async loadUsers() {
    try {
      const res = await this.dbQuery('SELECT username,nickname,password FROM users');
      this.loginMap.clear();
      res.results.forEach(u => this.loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password }));
      this.sysLog("用户", "用户数据加载完成", { 总数: res.results.length });
    } catch (e) {
      console.log("用户数据加载失败：" + e.message);
    }
  }

  cleanMatchTimer(uid) {
    try {
      if (this.userMatchTimer.has(uid)) {
        clearTimeout(this.userMatchTimer.get(uid));
        this.userMatchTimer.delete(uid);
      }
    } catch (e) {
      console.log("清除匹配计时器失败：" + e.message);
    }
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
      this.sysLog("聊天", "聊天结束", { 用户: me.username });
    } catch (e) {
      console.log("停止聊天失败：" + e.message);
    }
  }

  assignAiRobot(sid) {
    try {
      const u = this.userMap.get(sid);
      if (!u || !u.socket || u.isMatched) return;
      this.cleanMatchTimer(sid);
      u.partner = "ai_bot";
      u.isMatched = true;
      u.socket.send(JSON.stringify({ type: 'match-found', data: { partnerName: "AI陪伴者" } }));
      this.sysLog("匹配", "超时自动匹配AI成功", { 用户: u.username });
    } catch (e) {
      console.log("分配AI失败：" + e.message);
    }
  }

  async globalMatch(env, ctx, sid) {
    try {
      const user = this.userMap.get(sid);
      if (!user || !user.username) {
        console.log("匹配失败，用户未登录");
        return;
      }
      this.sysLog("匹配", "开始匹配", { 用户: user.username });

      let waitRaw = null;
      try { waitRaw = await this.env.bbb.get("global_match_wait"); } catch(e){}

      if (waitRaw) {
        const waitUser = JSON.parse(waitRaw);
        const targetUser = this.userMap.get(waitUser.sid);
        if (targetUser && targetUser.username) {
          try { ctx.waitUntil(this.env.bbb.delete("global_match_wait")); } catch(e){}
          
          this.cleanMatchTimer(sid);
          this.cleanMatchTimer(waitUser.sid);
          
          user.partner = waitUser.sid;
          targetUser.partner = sid;
          user.isMatched = true;
          targetUser.isMatched = true;
          
          user.socket.send(JSON.stringify({ type: "match-found", data: { partnerName: targetUser.username } }));
          targetUser.socket.send(JSON.stringify({ type: "match-found", data: { partnerName: user.username } }));
          
          this.sysLog("匹配", "真人匹配成功", { 用户1: user.username, 用户2: targetUser.username });
          return;
        }
      }

      try {
        ctx.waitUntil(this.env.bbb.put("global_match_wait", JSON.stringify({ sid, username: user.username })));
        this.sysLog("匹配", "进入排队池等待");
      } catch(e){}

      const timer = setTimeout(async () => {
        try {
          let w = null;
          try { w = await this.env.bbb.get("global_match_wait"); } catch(e){}
          if (w && JSON.parse(w).sid === sid) {
            try { ctx.waitUntil(this.env.bbb.delete("global_match_wait")); } catch(e){}
            this.assignAiRobot(sid);
          }
        } catch(e){}
      }, MATCH_TIMEOUT);
      this.userMatchTimer.set(sid, timer);
    } catch (e) {
      console.log("匹配流程崩溃：" + e.message);
    }
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
}

// ========== Worker入口（绑定名称ChatDO，和类名完全一致） ==========
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      console.log("外层收到请求：" + url.pathname);

      if (url.pathname.startsWith("/upload")) return env.cvvv.fetch(request);
      if (url.pathname.startsWith("/api/")) return env.nnn.fetch(request);

      // 【关键】调用绑定里的ChatDO
      const obj = env.ChatDO.get(env.ChatDO.idFromName("global-chat"), { locationHint: "apac" });
      return obj.fetch(request, env, ctx);
    } catch (e) {
      console.log("外层入口崩溃：" + e.message);
      return new Response("服务器繁忙", { status: 503 });
    }
  }
};

// ========== DO内部处理（类名ChatDO，强制匹配） ==========
ChatDO.prototype.fetch = async function(request, env, ctx) {
  try {
    const origin = request.headers.get('origin') || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true"
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const url = new URL(request.url);
    if (url.pathname.startsWith("/socket.io")) {
      console.log("收到WebSocket连接");
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") return new Response("需要WebSocket", { status: 400 });

      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      const sid = Math.random().toString(36).slice(2);
      const user = { id: sid, socket: server, username: "", partner: null, isMatched: false, lastKeepAlive: Date.now() };
      this.userMap.set(sid, user);
      this.sysLog("WebSocket", "客户端连接成功", { 连接ID: sid });

      const heartBeat = setInterval(() => {
        try { server.send(JSON.stringify({ type: "ping" })); } catch(e) { clearInterval(heartBeat); }
      }, HEARTBEAT_INTERVAL);

      const unloginTimer = setInterval(() => {
        try {
          if (!this.userMap.has(sid)) { clearInterval(unloginTimer); clearInterval(heartBeat); return; }
          if (!user.username) {
            server.close();
            this.userMap.delete(sid);
            clearInterval(unloginTimer);
            clearInterval(heartBeat);
            console.log("未登录超时关闭连接：" + sid);
          }
        } catch(e) {}
      }, UNLOGGED_CLEAN_INTERVAL);

      server.addEventListener("message", async (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log("收到消息：" + data.type);

          if (data.type === "ping") { server.send(JSON.stringify({ type: "pong" })); return; }
          if (data.type === "pong") { user.lastKeepAlive = Date.now(); return; }
          if (data.type === "user-online") {
            user.username = data.username;
            this.sysLog("用户上线", "登录成功", { 用户名: data.username });
            return;
          }
          if (data.type === "match-chat") await this.globalMatch(env, ctx, sid);
          if (data.type === "stop-chat") this.stopChat(sid, true);
          if (data.type === "send-msg") {
            const to = this.userMap.get(user.partner);
            if (to && to.socket) {
              await this.dbRun("INSERT INTO messages (sender,receiver,content) VALUES (?,?,?)", [user.username, to.username, data.data.content]);
              to.socket.send(JSON.stringify({ type: "new-msg", data: { content: data.data.content, fromName: user.username } }));
            }
          }
        } catch(e) { console.log("消息处理失败：" + e.message); }
      });

      server.addEventListener("close", async () => {
        try {
          this.cleanMatchTimer(sid);
          this.userMap.delete(sid);
          clearInterval(heartBeat);
          clearInterval(unloginTimer);
          console.log("连接关闭：" + sid);
        } catch(e) {}
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    await this.initDB();
    await this.loadUsers();

    return new Response("服务运行正常", { headers: corsHeaders });
  } catch (e) {
    console.log("DO全局崩溃：" + e.message);
    return new Response("服务器错误", { status: 500 });
  }
};
