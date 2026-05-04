  import { DurableObject } from "cloudflare:workers";

// ========== 环境绑定（和你原配置完全一致，一字不动）==========
const D1_BIND = "MY_MMM";
const KV_BIND = "bbb";
const DO_BIND = "ChatDO";
// ========== 前端域名配置（填你Pages绑定的域名，解决跨域）==========
const FRONTEND_DOMAIN = "https://im6.qzz.io";
// 新增：对方离线超时判定（30分钟，和前端5分钟心跳匹配）
const PARTNER_TIMEOUT = 1800000;

// ========== 核心Durable Object（原逻辑100%保留，仅修复匹配互斥+重连逻辑）==========
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
// 离线计时（前后台切换用）
this.userOfflineTime = new Map(); // 存用户最后离线时间
this.OFFLINE_LIMIT = 25 * 60 * 1000; // 25分钟阈值

   
    this.initOnlineCount();
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
    if (request.method === "OPTIONS") {
      return this.handleOptions();
    }

    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const res = await this.handleWS(request);
      return this.addCorsHeaders(res);
    }
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
    if (url.pathname === "/api/get_user_info") {
      const res = await this.handleGetUserInfo(request);
      return this.addCorsHeaders(res);
    }
    if (url.pathname === "/api/online") {
      const res = await this.handleGetOnline();
      return this.addCorsHeaders(res);
    }
    if (url.pathname === "/upload") {
      const res = await this.handleUpload(request);
      return this.addCorsHeaders(res);
    }

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

  // ========== WebSocket聊天核心（已修复匹配BUG）==========
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
      roomType: null
    };
    this.userMap.set(sid, user);

    client.addEventListener("message", async (e) => {
      try {
        const data = JSON.parse(e.data);

       // 【新增】前端切后台上报离线 → 后端记录离线时间
if (data.type === "USER_OFFLINE_REPORT") {
  if (user.username) {
    this.userOfflineTime.set(user.username, Date.now());
  }
  return;
}

        if (data.type === "user-online") {
          const { username } = data;
          if (!username || !this.loginMap.has(username)) return;
          user.username = username;
          this.userSessionMap.set(username, sid);
          this.usernameToSocket.set(username, client);
          await this.changeOnlineCount(1);
          this.broadcastSystemMsg(`👋 ${this.loginMap.get(username).nickname} 进入摸鱼基地`);
          this.autoJoinMatchPool(sid);
      // ========== 【第三段：离线时长判断 25分钟阈值】 ==========
const now = Date.now();
const lastOffline = this.userOfflineTime.get(username);
let needReset = false;

// 判断是否离线超过25分钟
if (lastOffline && now - lastOffline >= this.OFFLINE_LIMIT) {
  needReset = true;
  this.userOfflineTime.delete(username); // 清除过期离线记录
}

// 给前端发指令：重置 or 续连
if (needReset) {
  client.send(JSON.stringify({ type: "FORCE_RESET" }));
} else {
  client.send(JSON.stringify({ type: "RESUME_CONNECT" }));
}
// ======================================================

        
        }

        // ===================== 【修复1：match_reset 彻底清空状态】 =====================
        if (data.type === "match_reset") {
          this.cleanMatchTimer(sid);
          this.waitingUsers.delete(sid); // 关键修复：从队列删除
          this.stopChat(sid, true);
          user.isMatched = false; // 关键修复：重置匹配状态
          user.inRoomId = null;   // 关键修复：清空房间锁
          return;
        }

        // ===================== 【修复2：match-chat 允许重新匹配】 =====================
        if (data.type === "match-chat") {
          if (!user.username) return;
          
          // 彻底清空旧状态
          this.cleanMatchTimer(sid);
          this.waitingUsers.delete(sid);
          user.isMatched = false;
          user.inRoomId = null;

          // 重新加入匹配
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

        if (data.type === "HEARTBEAT") {
          if (!user.username) return;
          user.lastKeepAlive = Date.now();
          user.lastActive = Date.now();
          client.send(JSON.stringify({ type: "HEARTBEAT-ACK" }));
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

       // ========== 新增：切回前台检查（只单发，不广播，省Worker） ==========
if (data.type === "i_am_back") {
  if (!user.isMatched || !user.partner || !user.roomId) return;

  const partner = this.userMap.get(user.partner);
  const isPartnerOffline = !partner || (Date.now() - partner.lastActive > PARTNER_TIMEOUT);

  if (isPartnerOffline) {
    this.stopChat(user.id, false);

    // ✅ 只发给自己，不广播
    user.socket.send(JSON.stringify({
      type: "self_tips",
      content: "对方已离线，已为你重置匹配"
    }));
  }
  return;
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

  // ========== AI调用/匹配逻辑/房间管理（已修复）==========
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

  // ===================== 【修复3：stopChat 彻底重置】 =====================
  stopChat(sid, isInitiative = true) {
    const me = this.userMap.get(sid);
    if (!me) return;
    
    this.cleanMatchTimer(sid);
    this.waitingUsers.delete(sid); // 关键修复
    
    if (me.partner && me.partner !== "ai_bot") {
      const partner = this.userMap.get(me.partner);
      if (partner && partner.socket) {
        partner.partner = null;
        partner.isMatched = false;
        partner.inRoomId = null;
        partner.socket.send(JSON.stringify({ type: "partner-leave" }));
        me.roomId && partner.socket.send(JSON.stringify({ type: "clear-chat-record" }));
      }
    }

    // 彻底清空自己状态
    me.partner = null;
    me.isMatched = false;
    me.inRoomId = null;
    me.roomId = null;
    
    me.socket.send(JSON.stringify({ type: "match-end", info: isInitiative ? "已断开" : "结束" }));
    this.keepAliveMap.delete(sid);
    this.roomMem.delete(me.roomId);
    this.offlineMsgMem.delete(me.username);
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
    u.inRoomId = rid;
    u.roomType = "ai";

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

  // ===================== 【修复4：autoJoinMatchPool 宽松允许重入】 =====================
  autoJoinMatchPool(sid) {
    const u = this.userMap.get(sid);
    if (!u || !u.socket || !u.username) return;
    
    // 关键修复：只要空闲就允许进池
    if (u.isMatched || u.inRoomId) return;
    
    this.waitingUsers.delete(sid);
    this.cleanMatchTimer(sid);
    this.waitingUsers.add(sid);
    
    const timer = setTimeout(() => this.assignAiRobot(sid), 15000);
    this.userMatchTimer.set(sid, timer);
    this.tryMatch();
  }

  tryMatch() {
    const list = Array.from(this.waitingUsers)
      .map(id => this.userMap.get(id))
      .filter(u => u && u.socket && !u.partner && u.username);
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
      a.inRoomId = rid;
      a.roomType = "human";
      b.inRoomId = rid;
      b.roomType = "human";

      const aNick = this.loginMap.get(a.username)?.nickname || a.username;
      const bNick = this.loginMap.get(b.username)?.nickname || b.username;
      
      a.socket.send(JSON.stringify({ type: "match-found", partnerId: b.id, partnerName: bNick, selfId: a.id, roomId: rid }));
      b.socket.send(JSON.stringify({ type: "match-found", partnerId: a.id, partnerName: aNick, selfId: b.id, roomId: rid }));
      
      this.keepAliveMap.set(a.id, { partnerId: b.id, expireTime: Date.now() + 24 * 60 * 60 * 1000 });
      this.keepAliveMap.set(b.id, { partnerId: a.id, expireTime: Date.now() + 24 * 60 * 60 * 1000 });
    }
  }

  // ========== 图片/视频上传接口 ==========
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

// ========== Worker 入口 ==========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const doId = env[DO_BIND].idFromName("global");
    const chatDO = env[DO_BIND].get(doId);
    return await chatDO.fetch(request);
  }
};
