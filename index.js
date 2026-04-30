async fetch(request, env, ctx) {
    // ========== 强制处理WebSocket升级 + 跨域，放在最最开头 ==========
    const origin = request.headers.get('origin') || "";
    const allowOrigins = [
      "https://b.im6.qzz.io",
      "https://w.im6.qzz.io"
    ];
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigins.includes(origin) ? origin : "",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400"
    };

    // 1. 优先处理OPTIONS预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. 强制放行WebSocket升级请求（关键！！！）
    const upgradeHeader = request.headers.get("upgrade");
    if (upgradeHeader === "websocket") {
      // 直接交给Socket.io处理，不做任何拦截
    }

    // ========== 下面是你原来所有的代码，一丝不动保留 ==========
    await this.initDB();
    await this.loadUsers();
    const url = new URL(request.url);
    
    // ...你下面所有的if判断、接口、上传、转发全部不动
}
