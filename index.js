// ====================== 【严格符合Cloudflare官方文档｜零崩溃标准代码】 ======================
// 绑定严格对应：
// KV命名空间 = bbb | 耐用对象 = CHAT_DO | D1数据库 = MY_MMM | 前端服务 = nnn | 文件桶 = cvvv
// 完全遵守官方：类名大小写、调用逻辑、WebSocket握手、KV/D1访问规范
const KEEP_ALIVE_EXPIRE = 24 * 60 * 60 * 1000;
const KEEP_ALIVE_CHECK_INTERVAL = 60 * 1000;
const UNLOGGED_CLEAN_INTERVAL = 180000;
const REDIS_EXPIRE = 7200;
const MATCH_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 45000;
const HEARTBEAT_TIMEOUT = 60000;

// 【官方强制】耐用对象类名 与 Worker绑定名称 完全一致：CHAT_DO
export class CHAT_DO {
  // 【官方强制】构造函数：全局唯一实例初始化，绑定资源注入
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 内存存储：在线用户、计时器
    this.userMap = new Map();
    this.loginMap = new Map();
    this.userSessionMap = new Map();
    this.keepAliveMap = new Map();
    this.userMatchTimer = new Map();
    this.roomMem = new Map();
    this.offlineMsgMem = new Map();
    console.log("DO全局实例初始化完成，严格符合官方规范");
  }

  // D1数据库查询（官方标准）
  async dbQuery(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.all();
    } catch (e) {
      console.log("数据库查询失败：" + e.message);
      return { results: [] };
    }
  }

  // D1数据库执行（官方标准）
  async dbRun(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.run();
    } catch (e) {
      console.log("数据库执行失败：" + e.message);
      return null;
    }
  }

  // 中文日志（无特殊符号）
  sysLog(tag, msg, data = {}) {
    const t = new Date().toLocaleString('zh-CN');
    let logStr = "[" + t + "] " + tag + "：" + msg;
    if (Object.keys(data).length > 0) logStr += " 详情：" + JSON.stringify(data);
    console.log(logStr);
  }

  // AI接口调用
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

  // 初始化数据表
  async initDB() {
    try {
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        nick TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT,
        msg_type TEXT DEFAULT 'text',
        file_name TEXT,
        file_size INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS nickname_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        old_nickname TEXT,
        new_nickname TEXT,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS register_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        register_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      this.sysLog("数据库", "D1数据表初始化完成");
    } catch (err) {
      console.log("数据库初始化错误：" + err.message);
    }
  }

  // 加载用户列表
  async loadUsers() {
    try {
      const res = await this.dbQuery('SELECT username,nickname,password FROM users');
      this.loginMap.clear();
      res.results.forEach(u => {
        this.loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password });
      });
      this.sysLog("用户", "用户数据加载完成", { 总数: res.results.length });
    } catch (e) {
      console.log("用户数据加载失败：" + e.message);
    }
  }

  // 创建房间
  createMatchRoom(userA, userB) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random()*10000)}`;
    this.roomMem.set(roomId, { userA, userB, userALeft: false, userBLeft: false, createTime: Date.now() });
    setTimeout(() => this.roomMem.delete(roomId), REDIS_EXPIRE * 1000);
    return roomId;
  }

  // 清除匹配计时器
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

  // 停止聊天
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
          if(me.roomId) pt.socket.send(JSON.stringify({ type: 'clear-chat-record' }));
        }
      }
      me.partner = null;
      me.isMatched = false;
      me.socket.send(JSON.stringify({ type: 'match-end', data: { info: isInitiative ? '已断开' : '结束' } }));
      this.keepAliveMap.delete(uid);
      if (me.roomId) {
        this.roomMem.delete(me.roomId);
        this.offlineMsgMem.delete(me.username);
        me.roomId = null;
      }
      this.sysLog("聊天", "聊天结束", { 用户: me.username, 主动断开: isInitiative });
    } catch (e) {
      console.log("停止聊天操作失败：" + e.message);
    }
  }

  // 分配AI机器人
  assignAiRobot(sid) {
    try {
      const u = this.userMap.get(sid);
      if (!u || !u.socket || u.isMatched) {
        console.log("匹配AI失败，用户状态异常：" + sid);
        return;
      }
      this.cleanMatchTimer(sid);
      const aiName = "AI陪伴者";
      const aiId = "ai_bot";
      const rid = this.createMatchRoom(u.username, aiName);
      u.partner = aiId;
      u.isMatched = true;
      u.roomId = rid;
      this.keepAliveMap.set(sid, { partnerId: aiId, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
      u.socket.send(JSON.stringify({ type: 'match-found', data: { partnerId: aiId, partnerName: aiName, selfId: sid, roomId: rid } }));
      this.sysLog("匹配", "超时后自动匹配AI成功", { 用户: u.username });
    } catch (e) {
      console.log("分配AI机器人失败：" + e.message);
    }
  }

  // 【官方标准】全局匹配逻辑（KV排队池DO内部调用）
  async globalMatch(env, ctx, sid) {
    try {
      const user = this.userMap.get(sid);
      if (!user || !user.username) {
        console.log("匹配失败，用户信息异常，连接ID：" + sid);
        return;
      }
      this.sysLog("匹配", "开始执行匹配流程", { 用户: user.username, 连接ID: sid });

      // 【官方标准】DO内部调用KV排队池
      let waitRaw = null;
      try {
        waitRaw = await this.env.bbb.get("global_match_wait");
        console.log("读取排队池结果：", waitRaw);
      } catch (e) {
        console.log("读取全局排队池失败：" + e.message);
      }

      // 有排队用户 → 真人匹配
      if (waitRaw) {
        const waitUser = JSON.parse(waitRaw);
        const targetSid = waitUser.sid;
        const targetUser = this.userMap.get(targetSid);
        
        this.sysLog("匹配", "检测到排队中的用户，开始真人匹配", { 当前用户: user.username, 排队用户: targetUser?.username });
        
        // 清空排队池
        try {
          ctx.waitUntil(this.env.bbb.delete("global_match_wait"));
          console.log("已清空全局排队池");
        } catch (e) {
          console.log("清空全局排队池失败：" + e.message);
        }

        this.cleanMatchTimer(sid);
        this.cleanMatchTimer(targetSid);
        
        // 双向绑定匹配关系
        user.partner = targetSid;
        targetUser.partner = sid;
        user.isMatched = true;
        targetUser.isMatched = true;
        
        const rid = this.createMatchRoom(user.username, targetUser.username);
        user.roomId = rid;
        targetUser.roomId = rid;
        
        const aNick = this.loginMap.get(user.username)?.nickname || user.username;
        const bNick = this.loginMap.get(targetUser.username)?.nickname || targetUser.username;
        
        // 双向发送匹配成功
        user.socket.send(JSON.stringify({
          type: "match-found",
          data: { roomId: rid, partnerId: targetSid, partnerName: bNick }
        }));
        targetUser.socket.send(JSON.stringify({
          type: "match-found",
          data: { roomId: rid, partnerId: sid, partnerName: aNick }
        }));
        
        this.keepAliveMap.set(sid, { partnerId: targetSid, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
        this.keepAliveMap.set(targetSid, { partnerId: sid, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
        
        this.sysLog("匹配", "真人用户匹配成功", { 用户1: user.username, 用户2: targetUser.username });
      } else {
        // 无排队用户 → 进入排队池
        this.sysLog("匹配", "当前无排队用户，进入全局排队池等待", { 用户: user.username });
        const waitData = JSON.stringify({ sid: sid, username: user.username });
        
        try {
          ctx.waitUntil(this.env.bbb.put("global_match_wait", waitData));
          console.log("成功写入全局排队池：", waitData);
        } catch (e) {
          console.log("写入全局排队池失败：" + e.message);
        }

        // 15秒超时 → 匹配AI
        const timer = setTimeout(async () => {
          try {
            console.log("匹配等待15秒超时，开始检查排队状态");
            let w = null;
            try {
              w = await this.env.bbb.get("global_match_wait");
            } catch(e){}
            if (w && JSON.parse(w).sid === sid) {
              try {
                ctx.waitUntil(this.env.bbb.delete("global_match_wait"));
              } catch(e){}
              this.assignAiRobot(sid);
            } else {
              console.log("用户已被其他用户匹配，无需分配AI");
            }
          } catch (e) {
            console.log("匹配超时逻辑执行失败：" + e.message);
          }
        }, MATCH_TIMEOUT);
        
        this.userMatchTimer.set(sid, timer);
      }
    } catch (e) {
      console.log("全局匹配流程发生崩溃：" + e.message);
    }
  }

  // 保活检测
  startKeepAliveCheck() {
    setInterval(() => {
      try {
        const now = Date.now();
        this.keepAliveMap.forEach((val, uid) => {
          const u = this.userMap.get(uid);
          const p = this.userMap.get(val.partnerId);
          if (!u || !p || !u.socket || !p.socket || now - u.lastKeepAlive > HEARTBEAT_TIMEOUT) {
            this.keepAliveMap.delete(uid);
            this.keepAliveMap.delete(val.partnerId);
            try { u.socket.send(JSON.stringify({ type: 'partner-leave' })); } catch(e){}
            try { p.socket.send(JSON.stringify({ type: 'partner-leave' })); } catch(e){}
            this.sysLog("保活", "心跳超时或对方离线，自动断开聊天", { 用户1: u?.username, 用户2: p?.username });
            return;
          }
          if (now > val.expireTime) {
            this.stopChat(uid, false);
            this.stopChat(val.partnerId, false);
            this.keepAliveMap.delete(uid);
            this.keepAliveMap.delete(val.partnerId);
            this.sysLog("保活", "聊天保活时间过期，强制断开", { 用户1: u.username, 用户2: p.username });
            return;
          }
        });
      } catch (e) {
        console.log("保活检测循环发生崩溃：" + e.message);
      }
    }, KEEP_ALIVE_CHECK_INTERVAL);
  }
}

// 【官方标准】Worker外层入口（网关）
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      console.log("外层Worker收到请求，访问路径：" + url.pathname);

      // 静态资源、文件上传 → 转发绑定服务
      if (url.pathname.startsWith("/upload")) {
        return env.cvvv.fetch(request);
      }
      if (url.pathname.startsWith("/api/")) {
        return env.nnn.fetch(request);
      }

      // 【官方标准】调用全局唯一DO实例
      const doInstance = env.CHAT_DO.get(
        env.CHAT_DO.idFromName("global-chat-brain"),
        { locationHint: "apac" }
      );
      return doInstance.fetch(request, env, ctx);
    } catch (e) {
      console.log("外层入口处理请求崩溃：" + e.message);
      return new Response("服务器繁忙", { status: 503 });
    }
  }
};

// 【官方强制】DO内部fetch方法（唯一请求入口）
CHAT_DO.prototype.fetch = async function(request, env, ctx) {
    try {
      const origin = request.headers.get('origin') || "";
      const allowOrigins = [
        "https://www.im6.qzz.io",
        "https://w.im6.qzz.io"
      ];
      const corsHeaders = {
        "Access-Control-Allow-Origin": allowOrigins.includes(origin) ? origin : "",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400"
      };

      // 跨域预检
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);
      // 【官方标准】WebSocket握手处理
      if (url.pathname.startsWith("/socket.io")) {
        console.log("DO收到WebSocket连接请求，准备握手");
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader !== "websocket") {
          return new Response("需要WebSocket协议", { status: 400 });
        }

        // 【官方唯一标准】创建WebSocketPair
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        server.accept(); // 必须先accept，官方强制

        const sid = Math.random().toString(36).slice(2);
        const user = {
          id: sid, socket: server, username:'', partner:null, isMatched:false,
          lastActive:Date.now(), lastKeepAlive:Date.now(), roomId:null
        };
        this.userMap.set(sid, user);
        this.sysLog("WebSocket", "客户端连接成功", { 连接ID: sid });

        // 心跳定时器
        const heartBeatTimer = setInterval(() => {
          try {
            if (this.userMap.has(sid)) {
              server.send(JSON.stringify({ type: 'ping' }));
            } else {
              clearInterval(heartBeatTimer);
            }
          } catch (e) {
            clearInterval(heartBeatTimer);
            console.log("心跳消息发送失败，连接ID：" + sid);
          }
        }, HEARTBEAT_INTERVAL);

        // 未登录超时清理
        const unloginTimer = setInterval(() => {
          try {
            if (!this.userMap.has(sid)) {
              clearInterval(unloginTimer);
              clearInterval(heartBeatTimer);
              return;
            }
            if (!user.username || !this.loginMap.has(user.username) || this.userSessionMap.get(user.username) !== sid) {
              console.log("用户长时间未登录，关闭连接，连接ID：" + sid);
              server.close(1000, "未登录超时");
              this.userMap.delete(sid);
              clearInterval(unloginTimer);
              clearInterval(heartBeatTimer);
            }
          } catch (e) {
            clearInterval(unloginTimer);
            clearInterval(heartBeatTimer);
            console.log("未登录超时检测失败，连接ID：" + sid);
          }
        }, UNLOGGED_CLEAN_INTERVAL);

        // 接收客户端消息
        server.addEventListener("message", async (event) => {
          try {
            if (!this.userMap.has(sid)) return;
            const data = JSON.parse(event.data);
            console.log("收到客户端消息，连接ID：" + sid + " 消息类型：" + data.type);
            
            // 心跳响应
            if (data.type === "ping") {
              server.send(JSON.stringify({ type: "pong" }));
              return;
            }
            if (data.type === "pong") {
              user.lastKeepAlive = Date.now();
              return;
            }
            
            // 用户上线登录
            if (data.type === "user-online") {
              const { username } = data;
              if (!username || !this.loginMap.has(username)) return;
              user.username = username;
              this.userSessionMap.set(username, sid);
              try { ctx.waitUntil(this.env.bbb.put(`user_${username}`, sid)); } catch(e){}
              this.sysLog("用户上线", "用户登录成功", { 用户名: username });
              return;
            }
            
            // 匹配聊天核心指令
            if (data.type === "match-chat") {
              console.log("收到前端匹配聊天指令，当前用户：" + user.username);
              if (!user.username) return;
              if (user.isMatched) this.stopChat(sid, false);
              this.cleanMatchTimer(sid);
              await this.globalMatch(env, ctx, sid);
              return;
            }
            
            // 停止匹配
            if (data.type === "stop-chat") {
              this.cleanMatchTimer(sid);
              this.stopChat(sid, true);
              try {
                const waitRaw = await this.env.bbb.get("global_match_wait");
                if (waitRaw && JSON.parse(waitRaw).sid === sid) {
                  ctx.waitUntil(this.env.bbb.delete("global_match_wait"));
                }
              } catch(e){}
              return;
            }
            
            // 心跳保活
            if (data.type === "HEARTBEAT") {
              if (!user.username) return;
              user.lastKeepAlive = Date.now();
              user.lastActive = Date.now();
              server.send(JSON.stringify({ type: 'HEARTBEAT-ACK' }));
              return;
            }
            
            // 清空聊天记录
            if (data.type === "clear-chat") {
              if (user.username) await this.dbRun("DELETE FROM messages WHERE sender=? OR receiver=?", [user.username, user.username]);
              server.send(JSON.stringify({ type: 'clear-chat-record' }));
              return;
            }
            
            // 发送聊天消息
            if (data.type === "send-msg") {
              if (!user.username || !user.isMatched || !user.partner) return;
              const to = this.userMap.get(user.partner);
              const fromNick = this.loginMap.get(user.username)?.nickname || user.username;
              
              if (user.partner === 'ai_bot' && data.data.type === 'text') {
                const reply = await this.callAI(data.data.content);
                setTimeout(() => {
                  try {
                    server.send(JSON.stringify({
                      type: 'new-msg',
                      data: {
                        content: reply,
                        type: 'text',
                        burn: false,
                        msgId: Date.now().toString(),
                        fromName: 'AI陪伴者'
                      }
                    }));
                  } catch(e){}
                }, 600);
                return;
              }
              
              if (to && to.socket) {
                await this.dbRun("INSERT INTO messages (sender,receiver,content,msg_type) VALUES (?,?,?,?)", [
                  user.username, to.username, data.data.content, data.data.type || 'text'
                ]);
                try {
                  to.socket.send(JSON.stringify({
                    type: 'new-msg',
                    data: {
                      content: data.data.content,
                      type: data.data.type || 'text',
                      burn: data.data.burn || false,
                      msgId: data.data.msgId || '',
                      fromName: fromNick
                    }
                  }));
                } catch(e){}
              }
              return;
            }
            
            // 消息已读
            if (data.type === "msg-read") {
              const p = this.userMap.get(user.partner);
              if (p && p.socket) {
                try {
                  p.socket.send(JSON.stringify({ type: 'msg-read', data: { msgId: data.data.msgId } }));
                } catch(e){}
              }
              return;
            }
          } catch (err) {
            console.log("WebSocket消息处理失败：" + err.message);
          }
        });

        // 【官方标准】连接关闭清理
        server.addEventListener("close", async () => {
          try {
            this.cleanMatchTimer(sid);
            // 清理排队池
            try {
              const waitRaw = await this.env.bbb.get("global_match_wait");
              if (waitRaw && JSON.parse(waitRaw).sid === sid) {
                ctx.waitUntil(this.env.bbb.delete("global_match_wait"));
              }
            } catch(e){}
            // 清理用户会话
            if (user.username) {
              this.userSessionMap.delete(user.username);
              this.usernameToSocket.delete(user.username);
              try { ctx.waitUntil(this.env.bbb.delete(`user_${user.username}`)); } catch(e){}
            }
            this.keepAliveMap.delete(sid);
            this.userMap.delete(sid);
            clearInterval(unloginTimer);
            clearInterval(heartBeatTimer);
            this.sysLog("WebSocket断开", "客户端断开连接", { 连接ID: sid, 用户名: user.username });
          } catch (err) {
            console.log("连接关闭清理操作失败：" + err.message);
          }
        });

        // 【官方强制】返回101握手成功
        return new Response(null, { status: 101, webSocket: client, headers: corsHeaders });
      }

      // 初始化数据库和用户
      await this.initDB();
      await this.loadUsers();
      const url2 = new URL(request.url);

      // 根路径健康检查
      if (url2.pathname === "/") {
        return new Response('DO全局聊天服务运行正常', { headers: corsHeaders });
      }

      // 注册接口
      if (url2.pathname === "/register" && request.method === "POST") {
        const body = await request.json();
        const { username, password } = body;
        try {
            const existCheck = await this.dbQuery("SELECT 1 FROM users WHERE username = ?", [username]);
            if (existCheck.results.length > 0) {
                return new Response(JSON.stringify({ code: 400, msg: "该账号已被注册，请换一个" }), { headers: corsHeaders });
            }
            await this.dbRun("INSERT INTO users (username,password,nickname,created_at,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [username, password, username]);
            this.loginMap.set(username, { nickname: username, password });
            this.sysLog("注册", "账号注册成功", { 用户名: username });
            return new Response(JSON.stringify({ code: 200, msg: "注册成功，请登录" }), { headers: corsHeaders });
        } catch (err) {
            console.log("注册接口执行失败：" + err.message);
            return new Response(JSON.stringify({ code: 500, msg: "服务器异常，注册失败" }), { headers: corsHeaders });
        }
      }

      // 登录接口
      if (url2.pathname === "/login" && request.method === "POST") {
        const body = await request.json();
        const { username, password } = body;
        try {
            const userExist = await this.dbQuery("SELECT 1 FROM users WHERE username = ?", [username]);
            if (userExist.results.length === 0) {
                return new Response(JSON.stringify({ code: 400, msg: "账号不存在，请先注册" }), { headers: corsHeaders });
            }
            const user = await this.dbQuery("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
            if (user.results.length === 0) {
              return new Response(JSON.stringify({ code: 400, msg: "密码错误，请重新输入" }), { headers: corsHeaders });
            }
            const userInfo = user.results[0];
            this.loginMap.set(username, { nickname: userInfo.nickname || username, password });
            this.sysLog("登录", "账号登录成功", { 用户名: username });
            return new Response(JSON.stringify({
              code: 200,
              msg: "登录成功",
              data: { username: userInfo.username, nickname: userInfo.nickname || username }
            }), { headers: corsHeaders });
        } catch (err) {
            console.log("登录接口执行失败：" + err.message);
            return new Response(JSON.stringify({ code: 500, msg: "服务器异常，登录失败" }), { headers: corsHeaders });
        }
      }

      // 修改昵称接口
      if (url2.pathname === "/update-nickname" && request.method === "POST") {
        const body = await request.json();
        const { username, newNickname } = body;
        try {
          const nickRepeat = await this.dbQuery(`SELECT username FROM users WHERE nickname = ? AND username != ?`, [newNickname, username]);
          if (nickRepeat.results.length > 0) {
            return new Response(JSON.stringify({ code: 400, msg: '昵称已被占用，请换一个' }), { headers: corsHeaders });
          }
          const userInfo = await this.dbQuery(`SELECT nickname FROM users WHERE username = ?`, [username]);
          if (userInfo.results.length === 0) {
            return new Response(JSON.stringify({ code: 400, msg: '用户不存在' }), { headers: corsHeaders });
          }
          const oldNickname = userInfo.results[0].nickname;
          if (oldNickname === newNickname) {
            return new Response(JSON.stringify({ code: 200, msg: '昵称未发生变化' }), { headers: corsHeaders });
          }
          await this.dbRun(`UPDATE users SET nickname = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?`, [newNickname, username]);
          await this.dbRun(`INSERT INTO nickname_logs (username, old_nickname, new_nickname, create_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [username, oldNickname, newNickname]);
          if (this.loginMap.has(username)) {
            this.loginMap.set(username, { ...this.loginMap.get(username), nickname: newNickname });
          }
          this.sysLog("昵称修改", "用户昵称修改成功", { 用户名: username, 旧昵称: oldNickname, 新昵称: newNickname });
          return new Response(JSON.stringify({ code: 200, msg: '昵称修改成功', data: { username, oldNickname, newNickname } }), { headers: corsHeaders });
        } catch (err) {
          console.log("昵称修改接口执行失败：" + err.message);
          return new Response(JSON.stringify({ code: 500, msg: '服务器错误，修改失败' }), { headers: corsHeaders });
        }
      }

      // 在线用户列表接口
      if (url2.pathname === "/api/onlineUser") {
        const onlineList = [];
        this.userMap.forEach(item => {
          if (item.username && this.loginMap.has(item.username)) {
            const info = this.loginMap.get(item.username);
            onlineList.push({
              username: item.username,
              nickname: info.nickname || item.username,
              isMatched: item.isMatched ? "已匹配" : "空闲中"
            });
          }
        });
        return new Response(JSON.stringify({ code: 200, total: onlineList.length, list: onlineList }), { headers: corsHeaders });
      }

      // 清空聊天记录接口
      if (url2.pathname === "/api/clearChatOnly" && request.method === "POST") {
        try {
          await this.dbRun("DELETE FROM messages");
          this.offlineMsgMem.clear();
          this.sysLog("清空聊天", "聊天记录清空成功");
          return new Response(JSON.stringify({ code: 200, msg: "清空成功" }), { headers: corsHeaders });
        } catch (err) {
          console.log("清空聊天记录失败：" + err.message);
          return new Response(JSON.stringify({ code: 500, msg: "清空失败" }), { headers: corsHeaders });
        }
      }

      // 404
      return new Response("未找到该接口", { status: 404, headers: corsHeaders });

    } catch (globalErr) {
      console.log("DO全局处理逻辑发生致命崩溃：" + globalErr.message);
      return new Response("服务器内部错误", { status: 500 });
    }
};
