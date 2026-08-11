// Threads にテキストを1本投稿するスクリプト
// 使い方:  node post.mjs "投稿したい文章"
import { readFileSync } from "node:fs";

// .env を読む（トークンをコードに書かないため）
const env = Object.fromEntries(
  readFileSync(new URL("./.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const TOKEN = env.THREADS_ACCESS_TOKEN;
const BASE = "https://graph.threads.net/v1.0";

if (!TOKEN) {
  console.error("⚠️ .env に THREADS_ACCESS_TOKEN が入っていません");
  process.exit(1);
}

const text = process.argv[2];
if (!text) {
  console.error('使い方: node post.mjs "投稿したい文章"');
  process.exit(1);
}

// ユーザーIDが未取得なら /me で取得
let userId = env.THREADS_USER_ID;
if (!userId) {
  const me = await (await fetch(`${BASE}/me?fields=id,username&access_token=${TOKEN}`)).json();
  if (!me.id) {
    console.error("⚠️ ユーザーID取得に失敗:", JSON.stringify(me));
    process.exit(1);
  }
  userId = me.id;
  console.log(`ユーザーID: ${userId}（@${me.username}）→ .env の THREADS_USER_ID に控えておくと次回から速いです`);
}

// Step 1: 投稿コンテナ作成
const r1 = await fetch(`${BASE}/${userId}/threads`, {
  method: "POST",
  body: new URLSearchParams({ media_type: "TEXT", text, access_token: TOKEN }),
});
const c = await r1.json();
if (!c.id) {
  console.error("⚠️ コンテナ作成に失敗:", JSON.stringify(c));
  process.exit(1);
}

// Step 2: 5秒待ってから公開
await new Promise((r) => setTimeout(r, 5000));
const r2 = await fetch(`${BASE}/${userId}/threads_publish`, {
  method: "POST",
  body: new URLSearchParams({ creation_id: c.id, access_token: TOKEN }),
});
const p = await r2.json();
if (!p.id) {
  console.error("⚠️ 公開に失敗:", JSON.stringify(p));
  process.exit(1);
}
console.log(`✅ 投稿できました！ post_id: ${p.id}`);
