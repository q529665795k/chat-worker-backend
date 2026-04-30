// 纯静态页面 Worker，不依赖任何绑定、DO、数据库、KV
export default {
  async fetch() {
    return new Response(`
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>摸鱼基地</title>
          <style>
            body {
              background: #000;
              color: #fff;
              text-align: center;
              padding-top: 150px;
              font-size: 28px;
              margin: 0;
            }
          </style>
        </head>
        <body>
          ✅ 部署成功！服务器彻底救活！
        </body>
      </html>
    `, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};
