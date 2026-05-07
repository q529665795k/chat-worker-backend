import { DurableObject } from "cloudflare:workers";
const D1_BIND = "MY_MMM";
const KV_BIND = "bbb";
const DO_BIND = "ChatDO";
const FRONTEND_DOMAIN = "https://im6.qzz.io";
const PARTNER_TIMEOUT = 1800000;

// ====================== 跨域白名单 ======================
const ALLOWED_ORIGINS = ["https://im6.qzz.io"];
function checkOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin.trim());
}
// ======================================================

const AI_CHAT_MODEL = "qwen2.5-1.5b-instruct";
const AI_CHAT_INTERVAL = 12000;
const XIAOYA_SYS_PROMPT = "你叫小雅，温柔体贴、会倾听、简短走心、接地气。";
const XIAOZE_SYS_PROMPT = "你叫小泽，活泼幽默、爱唠嗑、轻松自然、有点调皮。";

export class ChatDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.env = env;
    this.userMap = new Map();
    this.waitingUsers = new Set();
    this.loginMap = new Map();
    this.userSessionMap = new Map();
    this.keepAliveMap = new Map();
    this.userMatchTimer = new Map();
    this.roomMem = new Map();
    this.offlineMsgMem = new Map();
    this.usernameToSocket = new Map();
    this.milestones = [2, 10, 100, 1000, 5000, 10000];
    this.triggeredMilestones = new Set();
    this.aiRoundChatList = [];
    this.aiLastSpeaker = "xiaoya";
    this.aiRoomPause = false;

    // 双AI自动聊天上下文
    this.aiContext = "开始聊天";
    this.aiTurn = "xiaoya";

    this.initOnlineCount();
    this.startAiAutoChat();
  }

  // ============== 双AI自动互聊（你要的效果） ==============
  startAiAutoChat() {
    setInterval(async () => {
      if (this.aiRoomPause) return;
      const isXiaoya = this.aiTurn === "xiaoya";
      const prompt = this.aiContext;

      try {
        const reply = isXiaoya
          ? await this.runAiModel(XIAOYA_SYS_PROMPT, prompt)
          : await this.runAiModel(XIAOZE_SYS_PROMPT, prompt);

        this.aiContext = reply;
        this.aiTurn = isXiaoya ? "xiaoze" : "xiaoya";

        this.userMap.forEach(user => {
          if (user.socket && user.inAiRoundRoom && user.socket.readyState === WebSocket.OPEN) {
            user.socket.send(JSON.stringify({
              type: "new-msg",
              fromName: isXiaoya ? "小雅" : "小泽",
              content: reply,
              burn: false,
              msgId: Date.now() + "",
              msgType: "text"
            }));
          }
        });
      } catch (e) {}
    }, AI_CHAT_INTERVAL);
  }

  async runAiModel(sysPrompt, userPrompt) {
    try {
      const res = await this.env.AI.run(AI_CHAT_MODEL, {
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt }
        ]
      });
      return res?.response || "我有点累了，稍后再聊吧~";
    } catch (e) {
      return "我有点累了，稍后再聊吧~";
    }
  }

  // ============== 用户插话，AI回复 ==============
  async userSayToAi(user, content) {
    const isXiaoya = Math.random() > 0.5;
    const reply = isXiaoya
      ? await this.runAiModel(XIAOYA_SYS_PROMPT, content)
      : await this.runAiModel(XIAOZE_SYS_PROMPT, content);

    user.socket.send(JSON.stringify({
      type: "new-msg",
      fromName: isXiaoya ? "小雅" : "小泽",
      content: reply,
      burn: false,
      msgId: Date.now() + "",
      msgType: "text"
    }));
  }

  addCorsHeaders(response, request) {
    const origin = request.headers.get("Origin");
    const newResponse = new Response(response.body, response);
    if (origin && checkOrigin(origin)) {
      newResponse.headers.set("Access-Control-Allow-Origin", origin);
      newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      newResponse.headers.set("Access-Control-Allow-Headers", "Content-Type");
      newResponse.headers.set("Access-Control-Allow-Credentials", "true");
    }
    newResponse.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return newResponse;
  }

  handleOptions(request) {
    const origin = request.headers.get("Origin");
    if (!origin || !checkOrigin(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  async initOnlineCount() {
    let count = await this.env[KV_BIND].get("online_count");
    this.onlineCount = count ? parseInt(count) : 0;
  }

  async changeOnlineCount(delta) {
    this.onlineCount = Math.max(0, this.onlineCount + delta);
    await this.env[KV_BIND].put("online_count", String(this.onlineCount));
    this.broadcastOnlineUpdate();
  }

  broadcastOnlineUpdate() {
    this.userMap.forEach((user) => {
      if (user.socket && user.socket.readyState === WebSocket.OPEN) {
        user.socket.send(JSON.stringify({ type: "online_update", count: this.onlineCount }));
      }
    });
  }

  broadcastSystemMsg(text) {
    this.userMap.forEach((user) => {
      if (user.socket && user.socket.readyState === WebSocket.OPEN) {
        user.socket.send(JSON.stringify({ type: "system_tip", text: text }));
      }
    });
  }

  async fetch(request) {
    if (request.method === "OPTIONS") return this.handleOptions(request);
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.addCorsHeaders(await this.handleWS(request), request);
    if (url.pathname === "/login") return this.addCorsHeaders(await this.handleLogin(request), request);
    if (url.pathname === "/register") return this.addCorsHeaders(await this.handleRegister(request), request);
    if (url.pathname === "/update-nickname") return this.addCorsHeaders(await this.handleUpdateNick(request), request);
    if (url.pathname === "/api/get_user_info") return this.addCorsHeaders(await this.handleGetUserInfo(request), request);
    return this.addCorsHeaders(new Response("OK", { status: 200 }), request);
  }

  async initDB() {
    await this.env[D1_BIND].prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, nickname TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
    await this.env[D1_BIND].prepare(`CREATE TABLE IF NOT EXISTS nickname_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, old_nickname TEXT, new_nickname TEXT, create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
    await this.env[D1_BIND].prepare(`CREATE TABLE IF NOT EXISTS login_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
    await this.env[D1_BIND].prepare(`CREATE TABLE IF NOT EXISTS register_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, password TEXT NOT NULL, register_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
    const userList = await this.env[D1_BIND].prepare("SELECT username,nickname,password FROM users").all();
    this.loginMap.clear();
    userList.results.forEach(u => {
      this.loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password });
    });
  }

  async handleRegister(request) {
    await this.initDB();
    const body = await request.json();
    const { username, password } = body;
    const exist = await this.env[D1_BIND].prepare("SELECT username FROM users WHERE username = ?").bind(username).all();
    if (exist.results.length > 0) {
      return new Response(JSON.stringify({ code: 400, msg: "用户名已存在" }), { headers: { "Content-Type": "application/json" } });
    }
    await this.env[D1_BIND].prepare("INSERT INTO users (username,password,nickname) VALUES (?,?,?)").bind(username, password, username).run();
    this.loginMap.set(username, { nickname: username, password });
    return new Response(JSON.stringify({ code: 200, msg: "注册成功" }), { headers: { "Content-Type": "application/json" } });
  }

  async handleLogin(request) {
    await this.initDB();
    const body = await request.json();
    const { username, password } = body;
    const user = await this.env[D1_BIND].prepare("SELECT username,password,nickname FROM users WHERE username = ?").bind(username).all();
    if (user.results.length === 0) return new Response(JSON.stringify({ code: 400, msg: "账号不存在" }));
    if (user.results[0].password !== password) return new Response(JSON.stringify({ code: 400, msg: "密码错误" }));
    return new Response(JSON.stringify({ code: 200, msg: "登录成功", data: { username, nickname: user.results[0].nickname } }));
  }

  async handleUpdateNick(request) {
    await this.initDB();
    const body = await request.json();
    const { username, newNickname } = body;
    await this.env[D1_BIND].prepare("UPDATE users SET nickname = ? WHERE username = ?").bind(newNickname, username).run();
    return new Response(JSON.stringify({ code: 200, msg: "修改成功" }));
  }

  async handleGetUserInfo(request) {
    const userId = new URL(request.url).searchParams.get("user_id");
    const user = await this.env[D1_BIND].prepare("SELECT username,nickname FROM users WHERE username = ?").bind(userId).all();
    if (user.results.length) return new Response(JSON.stringify({ code: 200, nick: user.results[0].nickname }));
    return new Response(JSON.stringify({ code: 404 }));
  }

  // ====================== 核心：WS消息处理（你原来逻辑全保留） ======================
  async handleWS(request) {
    await this.initDB();
    const [client, server] = new WebSocketPair();
    client.accept();
    const sid = crypto.randomUUID();
    const user = {
      id: sid, socket: client, username: "", partner: null,
      isMatched: false, lastActive: Date.now(), roomId: "", inAiRoundRoom: false
    };
    this.userMap.set(sid, user);

    client.addEventListener("message", async (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.type === "user-online") {
          user.username = data.username;
          this.userSessionMap.set(data.username, sid);
          this.usernameToSocket.set(data.username, client);
          await this.changeOnlineCount(1);
          this.autoJoinMatchPool(sid);
        }

        // ====================== 进入AI治疗房 → 禁用匹配 ======================
        if (data.type === "enter_ai_round_room") {
          user.inAiRoundRoom = true;
          user.partner = "ai_bot";
          user.isMatched = true;
          this.waitingUsers.delete(sid);
          client.send(JSON.stringify({ type: "disable_match" }));
          return;
        }

        // ====================== 退出AI房 → 恢复匹配 ======================
        if (data.type === "exit_ai_round_room") {
          user.inAiRoundRoom = false;
          user.partner = null;
          user.isMatched = false;
          client.send(JSON.stringify({ type: "enable_match" }));
          return;
        }

        // ====================== AI房内发消息 → 回复 ======================
        if (data.type === "send-msg" && user.inAiRoundRoom) {
          await this.userSayToAi(user, data.content);
          return;
        }

        // ====================== AI房期间，禁止一切匹配 ======================
        if (user.inAiRoundRoom && (data.type === "match-chat" || data.type === "show_match_modal")) {
          return;
        }

        if (data.type === "match_reset") {
          user.partner = null;
          user.isMatched = false;
          this.waitingUsers.delete(sid);
        }

        if (data.type === "match-chat") {
          this.waitingUsers.add(sid);
          setTimeout(() => this.assignAiRobot(sid), 15000);
          this.tryMatch();
        }

      } catch (err) {}
    });

    client.addEventListener("close", async () => {
      if (user.username) await this.changeOnlineCount(-1);
      this.userMap.delete(sid);
    });

    return new Response(null, { status: 101, webSocket: server });
  }

  assignAiRobot(sid) {
    const u = this.userMap.get(sid);
    if (!u || u.isMatched) return;
    u.partner = "ai_bot";
    u.isMatched = true;
    u.socket.send(JSON.stringify({
      type: "match-found",
      partnerId: "ai_bot",
      partnerName: "AI陪伴者",
      roomId: "ai_room"
    }));
  }

  autoJoinMatchPool(sid) {
    this.waitingUsers.add(sid);
    setTimeout(() => this.assignAiRobot(sid), 15000);
    this.tryMatch();
  }

  tryMatch() {
    const arr = Array.from(this.waitingUsers).filter(id => {
      const u = this.userMap.get(id);
      return u && !u.isMatched && !u.inAiRoundRoom;
    });
    if (arr.length < 2) return;
    const a = arr[0];
    const b = arr[1];
    const ua = this.userMap.get(a);
    const ub = this.userMap.get(b);
    ua.partner = b;
    ub.partner = a;
    ua.isMatched = true;
    ub.isMatched = true;
    this.waitingUsers.delete(a);
    this.waitingUsers.delete(b);
  }
}

export default {
  async fetch(request, env) {
    const id = env[DO_BIND].idFromName("global");
    return env[DO_BIND].get(id).fetch(request);
  }
};
