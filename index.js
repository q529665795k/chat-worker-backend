   import { DurableObject } from "cloudflare:workers";

// ========== 环境绑定（和你原配置完全一致，一字不动）==========
const D1_BIND = "MY_MMM";
const KV_BIND = "bbb";
const DO_BIND = "ChatDO";
// ========== 前端域名配置（填你Pages绑定的域名，解决跨域）==========
const FRONTEND_DOMAIN = "https://im6.qzz.io";

// ========== 核心Durable Object（原逻辑100%保留，仅移除前端HTML）==========
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
    this.initOnlineCount();

    // 【适配省电模式】定时兜底清理：每30秒清理一次超时的无效匹配状态
setInterval(() => {
  const now = Date.now();
  // 1. 清理等待池里，超过60秒没动静的用户（前端冻住了，没发取消指令）
  this.waitingUsers.forEach(sid => {
    const u = this.userMap.get(sid);
    if (!u || now - u.lastActive > 60000) {
      this.waitingUsers.delete(sid);
      this.cleanMatchTimer(sid);
    }
  });
  // 2. 清理超过2分钟没心跳的用户匹配状态，防止锁死
  this.userMap.forEach((u, sid) => {
    if (now - u.lastKeepAlive > 120000) {
      this.waitingUsers.delete(sid);
      this.cleanMatchTimer(sid);
      this.stopChat(sid, true);
      u.isMatched = false;
      u.partner = null;
      u.roomId = null;
    }
  });
}, 30000);
     
}

  // ========== CORS跨域处理（分离部署必加，已内置）==========
  addCorsHeaders(response) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", FRONTEND_DOMAIN);
    newResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    newResponse.headers.set("Access-Control-Allow-Headers", "Content-Type");
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
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // ========== 在线人数持久化逻辑 ==========
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
        user.socket.send(JSON.stringify({
          type: "online_update",
          count: this.onlineCount
        }));
      }
    });
  }

  broadcastSystemMsg(text) {
    this.userMap.forEach((user) => {
      if (user.socket && user.socket.readyState === WebSocket.OPEN) {
        user.socket.send(JSON.stringify({
          type: "system_tip",
          text: text
        }));
      }
    });
  }

  // ========== HTTP请求分发（纯后端路由，无前端返回）==========
  async fetch(request) {
    // 优先处理跨域预检请求
    if (request.method === "OPTIONS") {
      return this.handleOptions();
    }

    const url = new URL(request.url);
    // WebSocket聊天接口
    if (url.pathname === "/ws") {
      const res = await this.handleWS(request);
      return this.addCorsHeaders(res);
    }
    // 账号相关接口
    if (url.pathname === "/login") {
      const res = await this.handleLogin(request);
      return this.addCorsHeaders(res);
    }
    if (url.pathname === "/register") {
      const res = await this.handleRegister(request);
      return this.addCorsHeaders(res);
    }
    if (url.pathname === "/update-nickname") {
      const res = await this.handleUpdateNick(request);
      return this.addCorsHeaders(res);
    }
    // 用户&在线人数接口
    if (url.pathname === "/api/get_user_info") {
      const res = await this.handleGetUserInfo(request);
      return this.addCorsHeaders(res);
    }
    if (url.pathname === "/api/online") {
      const res = await this.handleGetOnline();
      return this.addCorsHeaders(res);
    }
    // 图片/视频上传接口
    if (url.pathname === "/upload") {
      const res = await this.handleUpload(request);
      return this.addCorsHeaders(res);
    }

    // 兜底：非接口请求返回404
    return this.addCorsHeaders(new Response("API Service Running", { status: 200 }));
  }

  // ========== 数据库初始化（原表结构100%保留）==========
  async initDB() {
    await this.env[D1_BIND].prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      nickname TEXT,
      nick TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `).run();
    await this.env[D1_BIND].prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      content TEXT,
      msg_type TEXT DEFAULT 'text',
      file_name TEXT,
      file_size INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `).run();
    await this.env[D1_BIND].prepare(`
    CREATE TABLE IF NOT EXISTS nickname_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      old_nickname TEXT,
      new_nickname TEXT,
      create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `).run();
    await this.env[D1_BIND].prepare(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `).run();
    await this.env[D1_BIND].prepare(`
    CREATE TABLE IF NOT EXISTS register_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      register_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `).run();

    const userList = await this.env[D1_BIND].prepare("SELECT username,nickname,password FROM users").all();
    this.loginMap.clear();
    userList.results.forEach(u => {
      this.loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password });
    });
  }

  // ========== 注册/登录/改昵称接口（原逻辑100%保留）==========
  async handleRegister(request) {
    await this.initDB();
    const body = await request.json();
    const { username, password } = body;
    const exist = await this.env[D1_BIND].prepare("SELECT username FROM users WHERE username = ?").bind(username).all();
    if (exist.results.length > 0) {
      return new Response(JSON.stringify({ code: 400, msg: "用户名已被注册" }), { headers: { "Content-Type": "application/json" } });
    }
    await this.env[D1_BIND].prepare("INSERT INTO users (username,password,nickname) VALUES (?,?,?)").bind(username, password, username).run();
    await this.env[D1_BIND].prepare("INSERT INTO register_logs (username,password) VALUES (?,?)").bind(username, password).run();
    this.loginMap.set(username, { nickname: username, password });
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
    if (user.results[0].password !== password) {
      return new Response(JSON.stringify({ code: 400, msg: "密码错误" }), { headers: { "Content-Type": "application/json" } });
    }
    await this.env[D1_BIND].prepare("INSERT INTO login_logs (username) VALUES (?)").bind(username).run();
    this.loginMap.set(username, { nickname: user.results[0].nickname, password: user.results[0].password });
    return new Response(JSON.stringify({
      code: 200,
      msg: "登录成功",
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

  // ========== 用户信息/在线人数接口 ==========
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

  // ========== WebSocket聊天核心（原逻辑100%保留，修复事件对齐）==========
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
      roomId: null
    };
    this.userMap.set(sid, user);

    client.addEventListener("message", async (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "user-online") {
          const { username } = data;
          if (!username || !this.loginMap.has(username)) return;
          user.username = username;
          this.userSessionMap.set(username, sid);
          this.usernameToSocket.set(username, client);
          await this.changeOnlineCount(1);
          this.broadcastSystemMsg(`👋 ${this.loginMap.get(username).nickname} 进入摸鱼基地`);
          this.autoJoinMatchPool(sid);
        }

        if (data.type === "match_reset") {
  // 【适配省电模式】全量强制重置，不留任何状态残留
  this.waitingUsers.delete(sid);
  this.cleanMatchTimer(sid);
  this.stopChat(sid, true);
  // 强制重置用户状态
  user.isMatched = false;
  user.partner = null;
  user.roomId = null;
  return;
}

        if (data.type === "match-chat") {

           // ========== 强制清空该用户所有历史残留 ==========
this.waitingUsers.delete(sid);
this.cleanMatchTimer(sid);
this.stopChat(sid, true);
this.userMap.get(sid).isMatched = false;

  // ============== 【适配省电模式】强制兜底清理，不管前端发没发重置，先清干净所有旧状态 ==============
  // 1. 校验用户合法性
  if (!user.username || !this.loginMap.has(user.username) || this.userSessionMap.get(user.username) !== sid) {
    return;
  }

  // 2. 【核心兜底】强制结束该用户的所有旧聊天、旧匹配，不管之前是什么状态
  this.waitingUsers.delete(sid); // 强制从等待池移除
  this.cleanMatchTimer(sid); // 强制清除AI匹配定时器
  this.stopChat(sid, true); // 强制结束当前所有聊天（包括AI）
  // 3. 强制重置用户对象的所有匹配状态
  user.isMatched = false;
  user.partner = null;
  user.roomId = null;
  // ==============================================================================

  // 4. 加入新的匹配池
  this.waitingUsers.add(sid);
  // 15秒没匹配到，分配AI机器人
  const timer = setTimeout(() => this.assignAiRobot(sid), 15000);
  this.userMatchTimer.set(sid, timer);
  // 5. 立即执行匹配
  this.tryMatch();
  return;
}


        if (data.type === "stop-chat") {
          this.waitingUsers.delete(sid);
          this.cleanMatchTimer(sid);
          this.stopChat(sid, true);
        }

        if (data.type === "HEARTBEAT") {
          if (!user.username) return;
          user.lastKeepAlive = Date.now();
          user.lastActive = Date.now();
          client.send(JSON.stringify({ type: "HEARTBEAT-ACK" }));
        }
       
  if (data.type === "KEEP_ALIVE") {
    if (!user.username) return;
    user.lastKeepAlive = Date.now();
    user.lastActive = Date.now();
    return;
  }

        if (data.type === "send-msg") {
          if (!user.username || !user.isMatched || !user.partner) return;
          const partner = this.userMap.get(user.partner);
          const fromNick = this.loginMap.get(user.username)?.nickname || user.username;
          
          if (user.partner === "ai_bot" && data.msgType === "text") {
            const aiReply = await this.callAI(data.content);
            setTimeout(() => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  type: "new-msg",
                  content: aiReply,
                  fromName: "AI陪伴者",
                  burn: false,
                  msgId: Date.now().toString(),
                  msgType: "text"
                }));
              }
            }, 600);
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
            await this.env[D1_BIND].prepare("INSERT INTO messages (sender,receiver,content,msg_type) VALUES (?,?,?,?)")
              .bind(user.username, partner.username, data.content, data.msgType || "text")
              .run();
          }
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

  // ========== AI调用/匹配逻辑/房间管理（原逻辑100%保留，加错误处理）==========
  async callAI(prompt) {
    try {
      const res = await fetch("https://useavnmd-mm.hf.space/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen2:0.5b", messages: [{ role: "user", content: prompt }], stream: false }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error("AI接口响应异常");
      const data = await res.json();
      return data.message?.content || "爸爸～在呢😘";
    } catch (e) {
      console.error("AI调用失败：", e);
      return "爸爸～我掉线啦🥺";
    }
  }

  createMatchRoom(userA, userB) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    this.roomMem.set(roomId, { userA, userB, userALeft: false, userBLeft: false, createTime: Date.now() });
    setTimeout(() => this.roomMem.delete(roomId), 7200 * 1000);
    return roomId;
  }

  stopChat(sid, isInitiative = true) {
    const me = this.userMap.get(sid);
    if (!me || !me.partner) return;
    this.cleanMatchTimer(sid);
    if (me.partner !== "ai_bot") {
      const partner = this.userMap.get(me.partner);
      if (partner && partner.socket) {
        partner.partner = null;
        partner.isMatched = false;
        partner.socket.send(JSON.stringify({ type: "partner-leave" }));
        me.roomId && partner.socket.send(JSON.stringify({ type: "clear-chat-record" }));
        this.autoJoinMatchPool(partner.id);
      }
    }
    me.partner = null;
    me.isMatched = false;
    me.socket.send(JSON.stringify({ type: "match-end", info: isInitiative ? "已断开" : "结束" }));
    this.keepAliveMap.delete(sid);
    if (me.roomId) {
      this.roomMem.delete(me.roomId);
      this.offlineMsgMem.delete(me.username);
      me.roomId = null;
    }
    this.autoJoinMatchPool(me.id);
  }

  cleanMatchTimer(sid) {
    if (this.userMatchTimer.has(sid)) {
      clearTimeout(this.userMatchTimer.get(sid));
      this.userMatchTimer.delete(sid);
    }
  }

  assignAiRobot(sid) {
    const u = this.userMap.get(sid);
    if (!u || !u.socket || u.isMatched || !this.waitingUsers.has(sid)) return;
    this.cleanMatchTimer(sid);
    const aiName = "AI陪伴者";
    const aiId = "ai_bot";
    const rid = this.createMatchRoom(u.username, aiName);
    u.partner = aiId;
    u.isMatched = true;
    u.roomId = rid;
    this.waitingUsers.delete(sid);
    this.keepAliveMap.set(sid, { partnerId: aiId, expireTime: Date.now() + 24 * 60 * 60 * 1000 });
    u.socket.send(JSON.stringify({
      type: "match-found",
      partnerId: aiId,
      partnerName: aiName,
      selfId: sid,
      roomId: rid
    }));
  }

  autoJoinMatchPool(sid) {
    const u = this.userMap.get(sid);
    if (!u || !u.socket || !u.username || !this.loginMap.has(u.username) || this.userSessionMap.get(u.username) !== sid || u.isMatched || this.waitingUsers.has(sid)) return;
    this.waitingUsers.add(sid);
    const timer = setTimeout(() => this.assignAiRobot(sid), 15000);
    this.userMatchTimer.set(sid, timer);
    this.tryMatch();
  }

  tryMatch() {
    const list = Array.from(this.waitingUsers)
      .map(id => this.userMap.get(id))
      .filter(u => u && u.socket && !u.partner && u.username && this.loginMap.has(u.username) && this.userSessionMap.get(u.username) === u.id);
    if (list.length < 2) return;
    for (let i = 0; i < list.length - 1; i += 2) {
      const a = list[i];
      const b = list[i + 1];
      if (!a || !b || a.id === b.id) continue;
      this.cleanMatchTimer(a.id);
      this.cleanMatchTimer(b.id);
      this.waitingUsers.delete(a.id);
      this.waitingUsers.delete(b.id);
      a.partner = b.id;
      b.partner = a.id;
      a.isMatched = true;
      b.isMatched = true;
      const rid = this.createMatchRoom(a.username, b.username);
      a.roomId = rid;
      b.roomId = rid;
      const aNick = this.loginMap.get(a.username)?.nickname || a.username;
      const bNick = this.loginMap.get(b.username)?.nickname || b.username;
      a.socket.send(JSON.stringify({ type: "match-found", partnerId: b.id, partnerName: bNick, selfId: a.id, roomId: rid }));
      b.socket.send(JSON.stringify({ type: "match-found", partnerId: a.id, partnerName: aNick, selfId: b.id, roomId: rid }));
      this.keepAliveMap.set(a.id, { partnerId: b.id, expireTime: Date.now() + 24 * 60 * 60 * 1000 });
      this.keepAliveMap.set(b.id, { partnerId: a.id, expireTime: Date.now() + 24 * 60 * 60 * 1000 });
    }
  }

  // ========== 图片/视频上传接口（原逻辑保留，加错误处理）==========
  async handleUpload(request) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    try {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) {
        return new Response(JSON.stringify({ error: "无文件" }), { 
          status: 400, 
          headers: { "Content-Type": "application/json" } 
        });
      }
      const uploadWorkerUrl = "https://b.im6.qzz.io/upload";
      const forwardForm = new FormData();
      forwardForm.append("file", file);
      const res = await fetch(uploadWorkerUrl, {
        method: "POST",
        body: forwardForm,
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error("上传服务响应异常");
      const result = await res.json();
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      console.error("上传接口报错：", err);
      return new Response(JSON.stringify({ error: "上传失败" }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  }
}

// ========== Worker 入口（原绑定逻辑完全一致）==========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const doId = env[DO_BIND].idFromName("global");
    const chatDO = env[DO_BIND].get(doId);
    return await chatDO.fetch(request);
  }
};
