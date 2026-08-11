// outbox/post.json を読み、画像付きで Threads に公開する（完全自動公開）
// 画像URLは GitHub の raw（コミットSHA固定）を使う → キャッシュ事故を避けられる
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, loadEnv, requireEnv } from "./config.mjs";

loadEnv();
requireEnv(["THREADS_ACCESS_TOKEN"]);

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const BASE = "https://graph.threads.net/v1.0";

const outboxPath = join(ROOT, "outbox", "post.json");
if (!existsSync(outboxPath)) {
  console.error("⚠️ outbox/post.json がありません。先に npm run generate を実行してください。");
  process.exit(1);
}
const { text, imagePath } = JSON.parse(readFileSync(outboxPath, "utf8"));

// --- 画像の公開URLを決める ---
// 優先: THREADS_IMAGE_BASE_URL（任意のホスティングを使う場合）
// 既定: GitHub raw（owner/repo は GITHUB_REPOSITORY、SHAは現在のHEAD＝push済みコミット）
function imageUrl() {
  const path = imagePath.replace(/\\/g, "/");
  if (process.env.THREADS_IMAGE_BASE_URL) {
    return `${process.env.THREADS_IMAGE_BASE_URL.replace(/\/$/, "")}/${path}`;
  }
  const repo = process.env.GITHUB_REPOSITORY || process.env.THREADS_IMAGE_REPO;
  if (!repo) {
    throw new Error(
      "画像URLを決められません。GitHub Actions外で動かす場合は THREADS_IMAGE_BASE_URL か THREADS_IMAGE_REPO(owner/repo) を設定してください。"
    );
  }
  const sha = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
  return `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
}

async function getUserId() {
  // トークンから正しいユーザーIDを取得（手動設定のズレを根本的に防ぐ）。
  // /me が通ればトークン自体も有効。失敗時のみ環境変数を予備に使う。
  const me = await (await fetch(`${BASE}/me?fields=id,username&access_token=${TOKEN}`)).json();
  if (me.id) {
    console.log(`👤 投稿アカウント: @${me.username}（id: ${me.id}）`);
    return me.id;
  }
  if (process.env.THREADS_USER_ID) return process.env.THREADS_USER_ID;
  throw new Error(
    "ユーザーID取得に失敗（トークンが無効/期限切れ/権限不足の可能性）: " + JSON.stringify(me)
  );
}

const userId = await getUserId();

// 画像があれば IMAGE 投稿、なければ TEXT 投稿（基本はテキストのみ）
const params = { access_token: TOKEN, text };
if (imagePath) {
  const url = imageUrl();
  console.log("🖼️  画像URL: " + url);
  params.media_type = "IMAGE";
  params.image_url = url;
} else {
  console.log("📄 テキストのみ投稿");
  params.media_type = "TEXT";
}

// Step 1: コンテナ作成
const r1 = await fetch(`${BASE}/${userId}/threads`, {
  method: "POST",
  body: new URLSearchParams(params),
});
const c = await r1.json();
if (!c.id) {
  throw new Error(
    "コンテナ作成に失敗: " +
      JSON.stringify(c) +
      "\nヒント: トークンに『threads_content_publish』権限が無い可能性があります。" +
      "Metaアプリの権限設定を確認し、その権限を含めてトークンを再発行してください。"
  );
}

// Step 2: 公開。画像は取り込みに時間がかかるため長めに待つ（公式推奨: 画像は最低30秒）
const waitMs = imagePath ? 30000 : 3000;
console.log(`⏳ ${waitMs / 1000}秒待ってから公開します`);
await new Promise((r) => setTimeout(r, waitMs));
const r2 = await fetch(`${BASE}/${userId}/threads_publish`, {
  method: "POST",
  body: new URLSearchParams({ creation_id: c.id, access_token: TOKEN }),
});
const p = await r2.json();
if (!p.id) throw new Error("公開に失敗: " + JSON.stringify(p));
console.log(`✅ 投稿できました！ post_id: ${p.id}`);
