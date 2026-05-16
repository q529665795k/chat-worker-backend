import { DurableObject } from "cloudflare:workers";

// ========== 配置区（新增密钥，务必修改！） ==========
const D1_BIND = "MY_MMM";
const KV_BIND = "bbb";
const DO_BIND = "ChatDO";
const FRONTEND_DOMAIN = "https://808.qzz.io";
// 🔴 这里改成你自己的强密钥，前端请求头必须带 X-API-Secret: 你的密钥
const API_SECRET = "Chat808_Secret_2026";
const PARTNER_TIMEOUT = 1800000;
const ONE_HOUR_MS = 3600000;

const AI_CHAT_MODEL = "@cf/qwen/qwen1.8b-chat";
const USER_AI_TTL = 604800;
const AI_CHAT_INTERVAL = 15000;
const AI_ROOM_LIMIT = 50;

const XIAOYA_SYS_PROMPT = "你叫小雅，性格温柔细腻、共情暖心、善于倾听，说话语气柔软文静、走心体贴，情商高，聊天接地气不浮夸，简短自然回复。";
const XIAOZE_SYS_PROMPT = "你叫小泽，性格开朗活泼、直爽幽默、爱唠嗑有点调皮，喜欢带动聊天气氛，说话接地气、轻松随性，简短自然回复。";

// ========== Durable Object 核心 ==========
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
    this.initOnlineCount();
    if (this.ctx?.setInterval) {
      this.startAutoKickTimer();
    }
  }

  startAutoKickTimer() {
    this.ctx.setInterval(() => this.autoKickOfflineUser(), 60000);
  }

  async autoKickOfflineUser() {
    const now = Date.now();
    const { results } = await this.env[D1_BIND].prepare(
      "SELECT username FROM users WHERE last_active_ts > 0 AND (? - last_active_ts) > ?"
    ).bind(now, ONE_HOUR_MS).all();

    for (const u of results) {
      await this.env[D1_BIND].prepare(
        "UPDATE users SET login_session = NULL, last_active_ts = 0 WHERE username = ?"
      ).bind(u.username).run();

      if (this.usernameToSocket.has(u.username)) {
        const ws = this.usernameToSocket.get(u.username);
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "force_logout", msg: "1小时无操作，已自动下线" }));
            ws.close(1000, "timeout_auto_logout");
          } catch (e) {}
        }
      }
      this.userSessionMap.delete(u.username);
      this.usernameToSocket.delete(u.username);
    }
  }

  async checkAndRefreshSession(username, clientWs) {
    const now = Date.now();
    const { results } = await this.env[D1_BIND].prepare(
      "SELECT login_session FROM users WHERE username = ?"
    ).bind(username).all();

    if (results.length === 0) return false;
    const dbSession = results[0].login_session;
    if (!dbSession) {
      try {
        clientWs.send(JSON.stringify({ type: "force_logout", msg: "账号已在其他设备登录，你已被挤下线" }));
        clientWs.close(1000, "login_kick_out");
      } catch (e) {}
      return false;
    }

    await this.env[D1_BIND].prepare(
      "UPDATE users SET last_active_ts = ? WHERE username = ?"
    ).bind(now, username).run();
    return true;
  }

  // 密码哈希加密（修复明文存储漏洞）
  async hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  addCorsHeaders(response) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", FRONTEND_DOMAIN);
    newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    // 新增鉴权头允许字段
    newResponse.headers.set("Access-Control-Allow-Headers", "Content-Type,X-API-Secret");
    newResponse.headers.set("Access-Control-Allow-Credentials", "true");
    newResponse.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return newResponse;
  }

  handleOptions() {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": FRONTEND_DOMAIN,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-API-Secret",
        "Access-Control-Allow-Credentials": "true",
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
    
    for (let m of this.milestones) {
      if (this.onlineCount >= m && !this.triggeredMilestones.has(m)) {
        this.triggeredMilestones.add(m);
        this.broadcastSystemMsg(`🎉 恭喜摸鱼基地在线人数突破${m}人！`);
      }
    }
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
        user.socket.send(JSON.stringify({ type: "system_tip", text }));
      }
    });
  }

  async saveUserAiChat(uid, content, fromName, toName) {
    const key = `user_ai_chat_${Date.now()}_${uid}`;
    const data = JSON.stringify({ uid, content, fromName, toName, time: Date.now() });
    await this.env[KV_BIND].put(key, data, { expirationTtl: USER_AI_TTL });
  }

  async saveAiSelfChat(content, speaker) {
    const key = `ai_self_chat_${Date.now()}_${speaker}`;
    const data = JSON.stringify({ content, speaker, time: Date.now() });
    await this.env[KV_BIND].put(key, data);
    this.aiRoundChatList.unshift(data);
    if (this.aiRoundChatList.length > 100) this.aiRoundChatList.pop();
  }

  async getAiRoomRecent50() {
    const list = await this.env[KV_BIND].list({ prefix: "ai_self_chat_" });
    const keys = list.keys.sort((a, b) => b.name.localeCompare(a.name)).slice(0, AI_ROOM_LIMIT);
    const res = [];
    for (let k of keys) {
      const val = await this.env[KV_BIND].get(k.name);
      if (val) res.push(JSON.parse(val));
    }
    return res.reverse();
  }

  async runAiModel(sysPrompt, userPrompt) {
    try {
      if (!this.env.AI) return "AI未绑定";
      const messages = [
        { role: "system", content: sysPrompt },
        { role: "user", content: userPrompt }
      ];
      const res = await this.env.AI.run(AI_CHAT_MODEL, { messages });
      return res?.response || "我暂时不知道怎么接话啦~";
    } catch (e) {
      console.error("AI调用失败", e);
      return "我有点累了，稍后再聊吧~";
    }
  }

  async callXiaoya(prompt) {
    return await this.runAiModel(XIAOYA_SYS_PROMPT, prompt);
  }

  async callXiaoze(prompt) {
    return await this.runAiModel(XIAOZE_SYS_PROMPT, prompt);
  }

  async getEmbedding(text) {
    try {
      const res = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", { text });
      return res?.data || [];
    } catch (e) {
      console.error("向量嵌入失败", e);
      return [];
    }
  }

  async aiAssistant(prompt) {
  try {
    // 第一步：用 Qwen 做意图识别
    let intent = "chat"; // 默认闲聊

    if (this.env.AI) {
      try {
        const intentResult = await this.env.AI.run("@cf/qwen/qwen1.5-0.5b-chat", {
          messages: [
            {
              role: "system",
              content: `你是一个意图识别器，只输出一个词。根据用户消息判断意图：
- 如果用户想生成图片/画画/生图 → 输出: image
- 如果用户想听语音/朗读/说话 → 输出: audio
- 如果用户想写代码/编程/开发 → 输出: code
- 如果用户想翻译/中译英/英译中 → 输出: translate
- 其他所有情况（闲聊/情感/问答/日常） → 输出: chat
只输出一个英文单词，不要输出任何其他内容。`
            },
            { role: "user", content: prompt }
          ],
          max_tokens: 10
        });

        const raw = (intentResult.response || "").trim().toLowerCase();

        if (raw.includes("image")) intent = "image";
        else if (raw.includes("audio")) intent = "audio";
        else if (raw.includes("code")) intent = "code";
        else if (raw.includes("translate")) intent = "translate";
        else intent = "chat";

      } catch (e) {
        console.error("意图识别失败，降级为闲聊:", e);
        intent = "chat";
      }
    }

    // 第二步：根据意图路由到对应模型
    switch (intent) {
      case "image": {
        const image = await this.env.AI.run("@cf/bytedance/lumina-dreamscape", { prompt });
        return { type: "image", url: image?.image || "" };
      }

      case "audio": {
        const audio = await this.env.AI.run("@cf/microsoft/samantha-tts", { text: prompt });
        return { type: "audio", url: audio?.audio || "" };
      }

      case "code": {
        const codeResult = await this.env.AI.run("@cf/qwen/qwen1.5-1.8b-chat", {
          messages: [
            { role: "system", content: "你是一个专业的编程助手，帮助用户写代码、调试和解答技术问题。请用中文回复。" },
            { role: "user", content: prompt }
          ]
        });
        return { type: "text", content: codeResult.response || "代码生成失败，请重试~" };
      }

      case "translate": {
        const translateResult = await this.env.AI.run("@cf/qwen/qwen1.5-1.8b-chat", {
          messages: [
            { role: "system", content: "你是一个翻译专家，帮用户翻译各种语言。请直接输出翻译结果，不要解释。" },
            { role: "user", content: prompt }
          ]
        });
        return { type: "text", content: translateResult.response || "翻译失败，请重试~" };
      }

      case "chat":
      default: {
        // 闲聊情感陪伴 随机小雅/小泽
        const isXiaoya = Math.random() > 0.5;
        const text = isXiaoya ? await this.callXiaoya(prompt) : await this.callXiaoze(prompt);
        return { type: "text", content: text };
      }
    }

  } catch (e) {
    console.error("AI助理异常", e);
    return { type: "text", content: "我暂时无法处理哦，换个说法吧~" };
  }
}


  broadcastAiRoundMsg(msgData) {
    this.userMap.forEach((user) => {
      if (user.socket && user.socket.readyState === WebSocket.OPEN && user.inAiRoundRoom) {
        user.socket.send(JSON.stringify({ type: "ai_round_new_msg", data: msgData }));
      }
    });
  }

  pauseAiRound() { this.aiRoomPause = true; }
  resumeAiRound() { this.aiRoomPause = false; }

  async fetch(request) {
    if (request.method === "OPTIONS") return this.handleOptions();
    const url = new URL(request.url);

    if (url.pathname === "/ws") return this.addCorsHeaders(await this.handleWS(request));
    if (url.pathname === "/login") return this.addCorsHeaders(await this.handleLogin(request));
    if (url.pathname === "/register") return this.addCorsHeaders(await this.handleRegister(request));
    if (url.pathname === "/update-nickname") return this.addCorsHeaders(await this.handleUpdateNick(request));
    if (url.pathname === "/api/get_user_info") return this.addCorsHeaders(await this.handleGetUserInfo(request));
    if (url.pathname === "/api/online") return this.addCorsHeaders(await this.handleGetOnline());
    if (url.pathname === "/upload") return this.addCorsHeaders(await this.handleUpload(request));
    
    if (url.pathname === "/api/ai_round_history") {
      const list = await this.getAiRoomRecent50();
      return this.addCorsHeaders(new Response(JSON.stringify({ code:200, list }), {
        headers: { "Content-Type":"application/json" }
      }));
    }

    return this.addCorsHeaders(new Response("API Service Running", { status: 200 }));
  }

  async initDB() {
    await this.env[D1_BIND].prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, nickname TEXT, nick TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
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
      return new Response(JSON.stringify({ code: 400, msg: "用户名已被注册" }), { headers: { "Content-Type": "application/json" } });
    }
    // 密码哈希加密存储，不再明文
    const passHash = await this.hashPassword(password);
    await this.env[D1_BIND].prepare("INSERT INTO users (username,password,nickname,login_session,last_active_ts) VALUES (?,?,?,NULL,0)").bind(username, passHash, username).run();
    await this.env[D1_BIND].prepare("INSERT INTO register_logs (username,password) VALUES (?,?)").bind(username, passHash).run();
    this.loginMap.set(username, { nickname: username, password: passHash });
    return new Response(JSON.stringify({ code: 200, msg: "注册成功", data: { username, nickname: username } }), { headers: { "Content-Type": "application/json" } });
  }

  async handleLogin(request) {
    await this.initDB();
    const body = await request.json();
    const { username, password } = body;
    const user = await this.env[D1_BIND].prepare("SELECT username,password,nickname FROM users WHERE username = ?").bind(username).all();
    if (user.results.length === 0) {
      return new Response(JSON.stringify({ code: 400, msg: "账号不存在" }), { headers: { "Content-Type": "application/json" } });
    }
    // 哈希密码校验
    const passHash = await this.hashPassword(password);
    if (user.results[0].password !== passHash) {
      return new Response(JSON.stringify({ code: 400, msg: "密码错误" }), { headers: { "Content-Type": "application/json" } });
    }

    const newSession = crypto.randomUUID();
    const now = Date.now();
    await this.env[D1_BIND].prepare(`
      UPDATE users 
      SET login_session = ?, last_active_ts = ? 
      WHERE username = ?
    `).bind(newSession, now, username).run();

    await this.env[D1_BIND].prepare("INSERT INTO login_logs (username) VALUES (?)").bind(username).run();
    this.loginMap.set(username, { nickname: user.results[0].nickname, password: passHash });

    return new Response(JSON.stringify({
      code: 200,
      msg: "登录成功",
      session: newSession,
      data: { username: user.results[0].username, nickname: user.results[0].nickname }
    }), { headers: { "Content-Type": "application/json" } });
  }

  async handleUpdateNick(request) {
    await this.initDB();
    const body = await request.json();
    const { username, newNickname } = body;
    const repeat = await this.env[D1_BIND].prepare("SELECT username FROM users WHERE nickname = ? AND username != ?").bind(newNickname, username).all();
    if (repeat.results.length > 0) {
      return new Response(JSON.stringify({ code: 400, msg: "昵称已被占用" }), { headers: { "Content-Type": "application/json" } });
    }
    const old = await this.env[D1_BIND].prepare("SELECT nickname FROM users WHERE username = ?").bind(username).all();
    const oldNick = old.results[0].nickname;
    if (oldNick === newNickname) {
      return new Response(JSON.stringify({ code: 200, msg: "昵称未变化" }), { headers: { "Content-Type": "application/json" } });
    }
    await this.env[D1_BIND].prepare("UPDATE users SET nickname = ? WHERE username = ?").bind(newNickname, username).run();
    await this.env[D1_BIND].prepare("INSERT INTO nickname_logs (username,old_nickname,new_nickname) VALUES (?,?,?)").bind(username, oldNick, newNickname).run();
    if (this.loginMap.has(username)) {
      this.loginMap.set(username, { ...this.loginMap.get(username), nickname: newNickname });
    }
    return new Response(JSON.stringify({ code: 200, msg: "修改成功", data: { oldNickname: oldNick, newNickname: newNickname } }), { headers: { "Content-Type": "application/json" } });
  }

  async handleGetUserInfo(request) {
    await this.initDB();
    const userId = new URL(request.url).searchParams.get("user_id");
    const user = await this.env[D1_BIND].prepare("SELECT username,nickname FROM users WHERE username = ?").bind(userId).all();
    if (user.results.length > 0) {
      return new Response(JSON.stringify({ code: 200, account: user.results[0].username, nick: user.results[0].nickname }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ code: 404, msg: "用户不存在" }), { headers: { "Content-Type": "application/json" } });
  }

  async handleGetOnline() {
    return new Response(JSON.stringify({ online: this.onlineCount }), { headers: { "Content-Type": "application/json" } });
  }

  async handleWS(request) {
    await this.initDB();
    const [client, server] = new WebSocketPair();
    client.accept();
    const sid = crypto.randomUUID();
    
    const user = {
      id: sid,
      socket: client,
      username: "",
      partner: null,
      isMatched: false,
      lastActive: Date.now(),
      lastKeepAlive: Date.now(),
      roomId: null,
      inRoomId: null,
      roomType: null,
      inAiRoundRoom: false
    };
    this.userMap.set(sid, user);

    client.addEventListener("message", async (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.type === "user-online") {
          const { username } = data;
          if (!username || !this.loginMap.has(username)) return;
          user.username = username;
          const valid = await this.checkAndRefreshSession(username, client);
          if (!valid) return;

          this.userSessionMap.set(username, sid);
          this.usernameToSocket.set(username, client);
          await this.changeOnlineCount(1);
          this.broadcastSystemMsg(`👋 ${this.loginMap.get(username).nickname} 进入摸鱼基地`);
          this.autoJoinMatchPool(sid);
        }

        if (data.type === "HEARTBEAT") {
          if (!user.username) return;
          user.lastKeepAlive = Date.now();
          user.lastActive = Date.now();
          await this.env[D1_BIND].prepare(
            "UPDATE users SET last_active_ts = ? WHERE username = ?"
          ).bind(Date.now(), user.username).run();
          client.send(JSON.stringify({ type: "HEARTBEAT-ACK" }));
        }

        if (data.type === "send-msg" && user.username) {
          await this.env[D1_BIND].prepare(
            "UPDATE users SET last_active_ts = ? WHERE username = ?"
          ).bind(Date.now(), user.username).run();

          const partner = this.userMap.get(user.partner);
          const fromNick = this.loginMap.get(user.username)?.nickname || user.username;

          if (user.inAiRoundRoom && data.msgType === "text") {
            this.pauseAiRound();
            await this.saveUserAiChat(user.username, data.content, fromNick, "AI圆桌");
            let aiReply;
            if (data.content.includes("@小雅")) {
              aiReply = await this.callXiaoya(data.content);
            } else if (data.content.includes("@小泽")) {
              aiReply = await this.callXiaoze(data.content);
            } else {
              aiReply = Math.random() > 0.5 ? await this.callXiaoya(data.content) : await this.callXiaoze(data.content);
            }
            setTimeout(() => this.resumeAiRound(), AI_CHAT_INTERVAL);
            client.send(JSON.stringify({
              type: "new-msg",
              content: aiReply,
              fromName: "AI助手",
              burn: false,
              msgId: Date.now().toString(),
              msgType: "text"
            }));
            return;
          }

          if (user.partner === "ai_bot" && data.msgType === "text") {
            try {
              const result = await this.aiAssistant(data.content);
              if (result.type === "text") {
                client.send(JSON.stringify({
                  type: "new-msg",
                  content: result.content,
                  fromName: "AI陪伴者",
                  burn: false,
                  msgId: Date.now().toString(),
                  msgType: "text"
                }));
              } else if (result.type === "image") {
                client.send(JSON.stringify({
                  type: "new-msg",
                  content: result.url,
                  fromName: "AI陪伴者",
                  burn: false,
                  msgId: Date.now().toString(),
                  msgType: "image"
                }));
              } else if (result.type === "audio") {
                client.send(JSON.stringify({
                  type: "new-msg",
                  content: result.url,
                  fromName: "AI陪伴者",
                  burn: false,
                  msgId: Date.now().toString(),
                  msgType: "audio"
                }));
              }
            } catch (err) {
              client.send(JSON.stringify({
                type: "new-msg",
                content: "我出错啦，再试一次~",
                fromName: "AI陪伴者",
                burn: false,
                msgId: Date.now().toString(),
                msgType: "text"
              }));
            }
            return;
          }

          if (partner && partner.socket && partner.socket.readyState === WebSocket.OPEN) {
            partner.socket.send(JSON.stringify({
              type: "new-msg",
              content: data.content,
              fromName: fromNick,
              burn: data.burn || false,
              msgId: data.msgId || "",
              msgType: data.msgType || "text"
            }));
          }
        }

        if (data.type === "enter_ai_round_room") {
          user.inAiRoundRoom = true;
          this.resumeAiRound();
          return;
        }

        if (data.type === "leave_ai_round_room") {
          user.inAiRoundRoom = false;
          return;
        }

        if (data.type === "match_reset") {
          this.cleanMatchTimer(sid);
          this.waitingUsers.delete(sid);
          this.stopChat(sid, true);
          user.isMatched = false;
          user.inRoomId = null;
          return;
        }

        if (data.type === "match-chat") {
          if (!user.username) return;
          this.cleanMatchTimer(sid);
          this.waitingUsers.delete(sid);
          user.isMatched = false;
          user.inRoomId = null;
          this.waitingUsers.add(sid);
          const timer = setTimeout(() => this.assignAiRobot(sid), 15000);
          this.userMatchTimer.set(sid, timer);
          this.tryMatch();
        }

        if (data.type === "stop-chat") {
          this.waitingUsers.delete(sid);
          this.cleanMatchTimer(sid);
          this.stopChat(sid, true);
        }

        if (data.type === "msg-read") {
          const partner = this.userMap.get(user.partner);
          if (partner && partner.socket && partner.socket.readyState === WebSocket.OPEN) {
            partner.socket.send(JSON.stringify({ type: "msg-read", msgId: data.msgId }));
          }
        }

        if (data.type === "clear-chat") {
          if (user.username) {
            await this.env[D1_BIND].prepare("DELETE FROM messages WHERE sender=? OR receiver=?").bind(user.username, user.username).run();
          }
          client.send(JSON.stringify({ type: "clear-chat-record" }));
        }

        if (data.type === "i_am_back") {
          if (!user.isMatched || !user.partner || !user.roomId) return;
          const partner = this.userMap.get(user.partner);
          const isPartnerOffline = !partner || (Date.now() - partner.lastActive > PARTNER_TIMEOUT);
          if (isPartnerOffline) {
            this.stopChat(user.id, false);
            user.socket.send(JSON.stringify({
              type: "self_tips",
              content: "对方已离线，已为你重置匹配"
            }));
          }
        }

      } catch (err) {
        console.error("WS消息处理失败：", err);
      }
    });

    client.addEventListener("close", async () => {
      this.cleanMatchTimer(sid);
      this.waitingUsers.delete(sid);
      if (user.username) {
        this.userSessionMap.delete(user.username);
        this.usernameToSocket.delete(user.username);
        await this.changeOnlineCount(-1);
        this.broadcastSystemMsg(`👋 ${this.loginMap.get(user.username)?.nickname || user.username} 离开摸鱼基地`);
      }
      this.keepAliveMap.delete(sid);
      this.userMap.delete(sid);
    });

    return new Response(null, { status: 101, webSocket: server });
  }

  createMatchRoom(userA, userB) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    this.roomMem.set(roomId, { userA, userB, userALeft: false, userBLeft: false, createTime: Date.now() });
    setTimeout(() => this.roomMem.delete(roomId), 7200 * 1000);
    return roomId;
  }

  stopChat(sid, isInitiative = true) {
    const me = this.userMap.get(sid);
    if (!me) return;
    this.waitingUsers.delete(sid);
    if (this.userMatchTimer.has(sid)) {
      clearTimeout(this.userMatchTimer.get(sid));
      this.userMatchTimer.delete(sid);
    }

    if (me.partner && me.partner !== "ai_bot") {
      const partner = this.userMap.get(me.partner);
      if (partner && partner.socket) {
        partner.partner = null;
        partner.isMatched = false;
        partner.socket.send(JSON.stringify({ type: "partner-leave" }));
      }
    }
    me.partner = null;
    me.isMatched = false;
    me.socket.send(JSON.stringify({ type: "match-end", info: isInitiative ? "已断开" : "结束" }));
  }

  assignAiRobot(sid) {
    const u = this.userMap.get(sid);
    if (!u || u.isMatched || !this.waitingUsers.has(sid)) return;
    this.cleanMatchTimer(sid);
    u.partner = "ai_bot";
    u.isMatched = true;
    u.socket.send(JSON.stringify({
      type: "match-found",
      partnerId: "ai_bot",
      partnerName: "AI陪伴者",
      selfId: sid
    }));
  }

  autoJoinMatchPool(sid) {
    const u = this.userMap.get(sid);
    if (!u || !u.username || u.isMatched) return;
    this.waitingUsers.add(sid);
    const timer = setTimeout(() => this.assignAiRobot(sid), 15000);
    this.userMatchTimer.set(sid, timer);
    this.tryMatch();
  }

  tryMatch() {
    const list = Array.from(this.waitingUsers)
      .map(id => this.userMap.get(id))
      .filter(u => u && u.socket && !u.partner && u.username && !u.isMatched);
    if (list.length < 2) return;
    for (let i = 0; i < list.length - 1; i += 2) {
      const a = list[i];
      const b = list[i + 1];
      if (!a || !b || a.id === b.id) continue;
      this.waitingUsers.delete(a.id);
      this.waitingUsers.delete(b.id);
      this.cleanMatchTimer(a.id);
      this.cleanMatchTimer(b.id);
      
      a.partner = b.id;
      b.partner = a.id;
      a.isMatched = true;
      b.isMatched = true;
      
      const aNick = this.loginMap.get(a.username)?.nickname || a.username;
      const bNick = this.loginMap.get(b.username)?.nickname || b.username;
      
      a.socket.send(JSON.stringify({ type: "match-found", partnerId: b.id, partnerName: bNick, selfId: a.id }));
      b.socket.send(JSON.stringify({ type: "match-found", partnerId: a.id, partnerName: aNick, selfId: b.id }));
    }
  }

  async callAiReply(prompt) {
    if (!this.env.AI) {
      return "AI未绑定，只能陪你打个招呼啦~";
    }
    try {
      const messages = [
        { role: "system", content: "你是一个简短回复的聊天助手，说话接地气，不啰嗦，一句话以内回答。" },
        { role: "user", content: prompt }
      ];
      const res = await this.env.AI.run("@cf/qwen/qwen1.5-0.5b-chat", { messages });
      return res?.response || "我有点累了，稍后再聊吧~";
    } catch (e) {
      console.error("AI调用失败：", e);
      return "调用AI失败，这是兜底回复：收到！";
    }
  }

  cleanMatchTimer(sid) {
    if (this.userMatchTimer.has(sid)) {
      clearTimeout(this.userMatchTimer.get(sid));
      this.userMatchTimer.delete(sid);
    }
  }

  async handleUpload(request) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    try {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) {
        return new Response(JSON.stringify({ error: "无文件" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const uploadWorkerUrl = "https://b.808.qzz.io/upload";
      const forwardForm = new FormData();
      forwardForm.append("file", file);
      const res = await fetch(uploadWorkerUrl, {
        method: "POST",
        body: forwardForm,
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error("上传服务响应异常");
      const result = await res.json();
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      console.error("上传接口报错：", err);
      return new Response(JSON.stringify({ error: "上传失败" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }
}

// ========== 全局入口：新增鉴权拦截，核心防护 ==========
export default {
  async fetch(request, env) {
    // 🔴 全局密钥鉴权，拦截所有外部爬虫/脚本调用
    const authKey = request.headers.get("X-API-Secret");
    const referer = request.headers.get("referer") || "";
    const isFrontend = referer.startsWith(FRONTEND_DOMAIN);
    const isOptions = request.method === "OPTIONS";

    // 只有你的前端 或 带正确密钥 允许访问
    if (!isFrontend && authKey !== API_SECRET && !isOptions) {
      return new Response("Forbidden", { status: 403 });
    }

    const doId = env[DO_BIND].idFromName("global");
    const chatDO = env[DO_BIND].get(doId);
    return await chatDO.fetch(request);
  }
};
