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
  if (process.env.THREADS_USER_ID) return process.env.THREADS_USER_ID;
  const me = await (await fetch(`${BASE}/me?fields=id,username&access_token=${TOKEN}`)).json();
  if (!me.id) throw new Error("ユーザーID取得に失敗: " + JSON.stringify(me));
  return me.id;
}

const userId = await getUserId();
const url = imageUrl();
console.log("🖼️  画像URL: " + url);

// Step 1: 画像コンテナ作成
const r1 = await fetch(`${BASE}/${userId}/threads`, {
  method: "POST",
  body: new URLSearchParams({ media_type: "IMAGE", image_url: url, text, access_token: TOKEN }),
});
const c = await r1.json();
if (!c.id) throw new Error("コンテナ作成に失敗: " + JSON.stringify(c));

// Step 2: 画像取り込みを待ってから公開（数秒必要）
await new Promise((r) => setTimeout(r, 8000));
const r2 = await fetch(`${BASE}/${userId}/threads_publish`, {
  method: "POST",
  body: new URLSearchParams({ creation_id: c.id, access_token: TOKEN }),
});
const p = await r2.json();
if (!p.id) throw new Error("公開に失敗: " + JSON.stringify(p));
console.log(`✅ 投稿できました！ post_id: ${p.id}`);
