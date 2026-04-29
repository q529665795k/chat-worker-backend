export default {
  async fetch(request, env, ctx) {
    // 锁定你的HF后端
    const HF_BACKEND = "https://useavnmd-im.hf.space";
    const reqUrl = new URL(request.url);
    // 把所有请求原封不动转发到HF
    const targetUrl = new URL(reqUrl.pathname + reqUrl.search, HF_BACKEND);

    // 转发请求
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow"
    });

    // 解决跨域、聊天长连接问题
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    newHeaders.set("Access-Control-Allow-Headers", "*");
    newHeaders.set("Access-Control-Allow-Credentials", "true");

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders
    });
  }
};
