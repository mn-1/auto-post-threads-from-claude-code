// Threads の長期トークンを更新する（約60日で失効するため）
// 新トークンを .new_token に書き出す → ワークフローが gh secret set で保存する
// 手元で使うときは表示された値を .env に貼り替えてください
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadEnv, requireEnv } from "./config.mjs";

loadEnv();
requireEnv(["THREADS_ACCESS_TOKEN"]);

const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const url =
  "https://graph.threads.net/refresh_access_token" +
  `?grant_type=th_refresh_token&access_token=${TOKEN}`;

const j = await (await fetch(url)).json();
if (!j.access_token) throw new Error("トークン更新に失敗: " + JSON.stringify(j));

const days = Math.round((j.expires_in || 0) / 86400);
console.log(`✅ トークンを更新しました（あと約 ${days} 日 有効）`);

// CI 用：新トークンをファイルに（.gitignore 済み）
writeFileSync(join(ROOT, ".new_token"), j.access_token);

// 手元実行時のヒント（値そのものはCIログでマスクされる想定）
if (!process.env.GITHUB_ACTIONS) {
  console.log("→ .env の THREADS_ACCESS_TOKEN を新しい値に貼り替えてください（.new_token に出力済み）");
}
