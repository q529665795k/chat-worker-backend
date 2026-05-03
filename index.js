 import { DurableObject } from "cloudflare:workers";

// ========== 环境绑定（和你原配置完全一致，一字不动）==========
const D1_BIND = "MY_MMM";
const KV_BIND = "bbb";
const DO_BIND = "ChatDO";
// ========== 前端域名配置（和你前端域名完全匹配）==========
const FRONTEND_DOMAIN = "https://im6.qzz.io";

// ========== 核心Durable Object（原逻辑100%保留，仅补全修复）==========
export class ChatDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.env = env;
    this.userMap = new Map(); // sid -> 用户完整对象
    this.waitingUsers = new Set(); // 等待匹配的sid集合
    this.loginMap = new Map(); // 用户名 -> 密码+昵称映射
    this.userSessionMap = new Map(); // 用户名 -> 当前最新sid（防多端重复登录）
    this.userSocketMap = new Map(); // 用户名 -> 当前最新WebSocket连接
    this.keepAliveMap = new Map();
    this.userMatchTimer = new Map();
    this.roomMem = new Map(); // 【修复】roomId -> 房间完整信息（含用户名-sid映射）
    this.offlineMsgMem = new Map();
    this.milestones = [2, 10, 100, 1000, 5000, 10000];
    this.triggeredMilestones = new Set();
    this.initOnlineCount();
  }

  // ========== CORS跨域处理（分离部署必加，已内置，和前端完全匹配）==========
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
    // 图片/视频上传接口（前端已改用Base64，保留兜底）
    if (url.pathname === "/upload") {
      const res = await this.handleUpload(request);
      return this.addCorsHeaders(res);
    }

    // 兜底：非接口请求返回服务状态
    return this.addCorsHeaders(new Response("😎 你来啦，服务稳稳在线~", { status: 200 }));
  }

  // ========== 数据库初始化（原表结构100%保留，和前端接口完全匹配）==========
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

  // ========== 注册/登录/改昵称接口（原逻辑100%保留，和前端字段完全匹配）==========
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

  // ========== 用户信息/在线人数接口（和前端请求完全匹配）==========
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

  // ========== WebSocket聊天核心（补全重连逻辑，修复bug，和前端100%对齐）==========
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
        // 【修复】用户上线逻辑：防重复统计在线人数，清理旧连接
        if (data.type === "user-online") {
          const { username, nickname } = data;
          if (!username || !this.loginMap.has(username)) return;
          
          // 【修复】如果用户已有旧连接，先清理旧连接，避免在线人数虚高
          const oldSid = this.userSessionMap.get(username);
          if (oldSid && oldSid !== sid) {
            const oldUser = this.userMap.get(oldSid);
            if (oldUser && oldUser.socket) {
              oldUser.socket.close(1000, "账号在其他地方登录");
            }
            this.userMap.delete(oldSid);
            this.waitingUsers.delete(oldSid);
            this.cleanMatchTimer(oldSid);
          }

          // 更新当前用户信息
          user.username = username;
          this.userSessionMap.set(username, sid);
          this.userSocketMap.set(username, client);
          
          // 【修复】只有新用户上线才增加在线人数
          if (!oldSid) {
            await this.changeOnlineCount(1);
            this.broadcastSystemMsg(`👋 ${nickname || this.loginMap.get(username).nickname} 进入摸鱼基地`);
          }
          
          this.autoJoinMatchPool(sid);
          return;
        }

        // 【新增】前端重连核心：恢复房间逻辑，和前端重连代码完全匹配
        if (data.type === "rejoin-room") {
          const { roomId, userId: username, partnerId } = data;
          if (!username || !roomId || !this.loginMap.has(username)) return;

          // 验证房间是否存在
          const room = this.roomMem.get(roomId);
          if (!room) {
            client.send(JSON.stringify({ type: "partner-leave" }));
            return;
          }

          // 验证用户是否属于这个房间
          const isRoomUser = room.userA.username === username || room.userB.username === username;
          if (!isRoomUser) {
            client.send(JSON.stringify({ type: "partner-leave" }));
            return;
          }

          // 更新当前用户的房间状态
          const isUserA = room.userA.username === username;
          const partnerUser = isUserA ? room.userB : room.userA;
          
          // 更新用户对象状态
          user.username = username;
          user.roomId = roomId;
          user.partner = partnerUser.sid;
          user.isMatched = true;
          
          // 更新房间里的用户sid和socket
          if (isUserA) {
            room.userA.sid = sid;
            room.userA.socket = client;
          } else {
            room.userB.sid = sid;
            room.userB.socket = client;
          }
          this.roomMem.set(roomId, room);

          // 更新全局映射
          this.userSessionMap.set(username, sid);
          this.userSocketMap.set(username, client);
          this.keepAliveMap.set(sid, { partnerId: partnerUser.sid, expireTime: Date.now() + 24 * 60 * 60 * 1000 });

          // 给前端返回恢复成功
          client.send(JSON.stringify({
            type: "rejoin-success",
            roomId: roomId,
            partnerId: partnerUser.sid,
            partnerName: this.loginMap.get(partnerUser.username)?.nickname || partnerUser.username
          }));

          // 给对方发送用户重连上线通知
          if (partnerUser.socket && partnerUser.socket.readyState === WebSocket.OPEN) {
            partnerUser.socket.send(JSON.stringify({
              type: "system_tip",
              text: `✅ 对方已重新连接`
            }));
          }
          return;
        }

        if (data.type === "match_reset") {
          this.waitingUsers.delete(sid);
          this.cleanMatchTimer(sid);
          this.stopChat(sid, true);
          return;
        }

        if (data.type === "match-chat") {
          if (!user.username) return;
          if (user.isMatched) this.stopChat(sid, false);
          this.waitingUsers.delete(sid);
          this.cleanMatchTimer(sid);
          this.waitingUsers.add(sid);
          const timer = setTimeout(() => this.assignAiRobot(sid), 15000);
          this.userMatchTimer.set(sid, timer);
          this.tryMatch();
          return;
        }

        if (data.type === "stop-chat") {
          this.waitingUsers.delete(sid);
          this.cleanMatchTimer(sid);
          this.stopChat(sid, true);
          return;
        }

        // 心跳逻辑（和前端完全匹配）
        if (data.type === "HEARTBEAT") {
          if (!user.username) return;
          user.lastKeepAlive = Date.now();
          user.lastActive = Date.now();
          client.send(JSON.stringify({ type: "HEARTBEAT-ACK" }));
          return;
        }

        // 发消息逻辑（和前端Base64媒体完全兼容）
        if (data.type === "send-msg") {
          if (!user.username || !user.isMatched || !user.partner) return;
          const partner = this.userMap.get(user.partner);
          const fromNick = this.loginMap.get(user.username)?.nickname || user.username;
          
          // AI聊天逻辑（保留原逻辑，加异常兜底）
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
          
          // 双人聊天消息转发（兼容Base64图片/视频）
          if (partner && partner.socket && partner.socket.readyState === WebSocket.OPEN) {
            partner.socket.send(JSON.stringify({
              type: "new-msg",
              content: data.content,
              fromName: fromNick,
              burn: data.burn || false,
              msgId: data.msgId || "",
              msgType: data.msgType || "text"
            }));
            // 消息持久化
            await this.env[D1_BIND].prepare("INSERT INTO messages (sender,receiver,content,msg_type) VALUES (?,?,?,?)")
              .bind(user.username, partner.username, data.content, data.msgType || "text")
              .run();
          }
          return;
        }

        // 已读回执（和前端完全匹配）
        if (data.type === "msg-read") {
          const partner = this.userMap.get(user.partner);
          if (partner && partner.socket && partner.socket.readyState === WebSocket.OPEN) {
            partner.socket.send(JSON.stringify({ type: "msg-read", msgId: data.msgId }));
          }
          return;
        }

        // 清空聊天记录（和前端完全匹配）
        if (data.type === "clear-chat") {
          if (user.username) {
            await this.env[D1_BIND].prepare("DELETE FROM messages WHERE sender=? OR receiver=?").bind(user.username, user.username).run();
          }
          client.send(JSON.stringify({ type: "clear-chat-record" }));
          return;
        }
      } catch (err) {
        console.error("WS消息处理失败：", err);
      }
    });

    // 连接关闭逻辑（修复脏数据清理）
    client.addEventListener("close", async () => {
      this.cleanMatchTimer(sid);
      this.waitingUsers.delete(sid);
      
      // 清理用户映射
      if (user.username) {
        const currentSid = this.userSessionMap.get(user.username);
        // 只有当前关闭的是最新连接，才清理映射和在线人数
        if (currentSid === sid) {
          this.userSessionMap.delete(user.username);
          this.userSocketMap.delete(user.username);
          await this.changeOnlineCount(-1);
          this.broadcastSystemMsg(`👋 ${this.loginMap.get(user.username)?.nickname || user.username} 离开摸鱼基地`);
        }
      }
      
      // 清理内存数据
      this.keepAliveMap.delete(sid);
      this.userMap.delete(sid);
    });

    return new Response(null, { status: 101, webSocket: server });
  }

  // ========== AI调用（保留原逻辑，加异常兜底）==========
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

  // 【修复】房间创建逻辑：存储完整用户信息，支持重连恢复
  createMatchRoom(userA, userB) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    this.roomMem.set(roomId, {
      roomId: roomId,
      userA: {
        sid: userA.id,
        username: userA.username,
        socket: userA.socket
      },
      userB: {
        sid: userB.id,
        username: userB.username,
        socket: userB.socket
      },
      createTime: Date.now()
    });
    // 2小时自动清理房间
    setTimeout(() => this.roomMem.delete(roomId), 7200 * 1000);
    return roomId;
  }

  // 【修复】结束聊天逻辑：清理房间脏数据
  stopChat(sid, isInitiative = true) {
    const me = this.userMap.get(sid);
    if (!me || !me.partner) return;
    this.cleanMatchTimer(sid);
    
    // 清理AI聊天
    if (me.partner === "ai_bot") {
      me.partner = null;
      me.isMatched = false;
      me.roomId = null;
      me.socket.send(JSON.stringify({ type: "partner-leave" }));
      this.autoJoinMatchPool(me.id);
      return;
    }

    // 清理双人聊天
    const partner = this.userMap.get(me.partner);
    if (partner && partner.socket) {
      // 重置对方状态
      partner.partner = null;
      partner.isMatched = false;
      partner.roomId = null;
      partner.socket.send(JSON.stringify({ type: "partner-leave" }));
      partner.socket.send(JSON.stringify({ type: "clear-chat-record" }));
      this.autoJoinMatchPool(partner.id);
    }

    // 重置自己状态
    me.partner = null;
    me.isMatched = false;
    me.roomId = null;
    me.socket.send(JSON.stringify({ type: "partner-leave" }));
    me.socket.send(JSON.stringify({ type: "clear-chat-record" }));
    
    // 清理房间数据
    if (me.roomId) this.roomMem.delete(me.roomId);
    this.keepAliveMap.delete(sid);
    this.autoJoinMatchPool(me.id);
  }

  cleanMatchTimer(sid) {
    if (this.userMatchTimer.has(sid)) {
      clearTimeout(this.userMatchTimer.get(sid));
      this.userMatchTimer.delete(sid);
    }
  }

  // AI匹配逻辑（原逻辑100%保留）
  assignAiRobot(sid) {
    const u = this.userMap.get(sid);
    if (!u || !u.socket || u.isMatched || !this.waitingUsers.has(sid)) return;
    this.cleanMatchTimer(sid);
    const aiName = "AI陪伴者";
    const aiId = "ai_bot";
    const rid = `room_ai_${Date.now()}`;
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

  // 匹配逻辑（原逻辑100%保留）
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
      const rid = this.createMatchRoom(a, b);
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

  // ========== 图片/视频上传接口（前端已改用Base64，保留兜底）==========
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

// ========== Worker 入口（原绑定逻辑完全一致，无需修改）==========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const doId = env[DO_BIND].idFromName("global");
    const chatDO = env[DO_BIND].get(doId);
    return await chatDO.fetch(request);
  }
};
