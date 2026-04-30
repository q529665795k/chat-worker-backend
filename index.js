// 【兜底保命版】啥功能都不做，先让服务器活着！
export class ChatDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    // 直接返回最简单的页面，不碰任何数据库、KV、复杂逻辑
    return new Response(`
      <html>
        <body style="background:#000;color:#fff;text-align:center;padding-top:50px">
          <h1>✅ 服务器救活了！不繁忙了！</h1>
        </body>
      </html>
    `, { headers: { "Content-Type": "text/html" } });
  }
}

// Worker入口极简写法
export default {
  async fetch(request, env) {
    const obj = env.ChatDO.get(env.ChatDO.idFromName("global"));
    return obj.fetch(request);
  }
};
