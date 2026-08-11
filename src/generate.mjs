// 本文生成（Claude）＋ 時々シンプルな引用カード（sharpのみ・無料）
// 調査結論に基づき「テキスト中心・画像は時々・AI顔合成/文字焼き込みはしない」方針。
// 出力: outbox/post.json（本文・imagePath は画像なしなら null）
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT, loadEnv, loadPersona, requireEnv } from "./config.mjs";

loadEnv();
// 文章=Claude（必須）。画像はローカルでカード生成のみ（外部API不要）。
requireEnv(["ANTHROPIC_API_KEY"]);
const persona = loadPersona();

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY を自動で読む
const TEXT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

// --- ネタと型を決める（乱数を使わず、日付＋時刻で決定的に回す）---
// 1日に複数回走っても、時刻(UTC hour)が違うので別のネタ・型になる。
function pick(arr, offset = 0) {
  const now = new Date();
  const dayOfYear = Math.floor(
    (now - new Date(now.getFullYear(), 0, 0)) / 86400000
  );
  const slot = dayOfYear * 24 + now.getUTCHours();
  return arr[(slot + offset) % arr.length];
}

const topics = (persona.topics_pool || []).filter((t) => t && !String(t).includes("<"));
const styles = persona.use_styles || ["③質問・問いかけ型"];
const topic = topics.length ? pick(topics) : persona.genre;

// --- 投稿枠(スロット)を決める：実行時刻(UTC)に最も近い枠を選ぶ ---
// 朝=価値提供 / 夕=共感ストーリー / 夜=問いかけ、と役割を固定してローテを避ける。
// slots が無い設定なら従来どおり use_styles を時刻でローテ（後方互換）。
function currentSlot() {
  const slots = Array.isArray(persona.slots) ? persona.slots : [];
  if (!slots.length) return null;
  const h = new Date().getUTCHours();
  let best = null, bestD = 99;
  for (const s of slots) {
    const t = Number(s.utc_hour);
    if (Number.isNaN(t)) continue;
    const raw = Math.abs(h - t);
    const d = Math.min(raw, 24 - raw); // 円環距離（23時と1時は近い）
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
const slot = currentSlot();
const style = slot?.style || pick(styles, 1);

// 締め方は枠ごとに変える（毎回"質問締め"を避ける。質問は夜の枠だけに集中させる）
const closingRules = {
  save: "締めは「保存しておくと後で見返せます」など保存を促す一言で終える 疑問文では終えない",
  soft: "締めは静かな余韻で終える 無理に質問で締めない 押し付けない",
  question: "締めは「〜な人います？」または「？」「…」で終え 返信を誘う",
};
const closing = closingRules[slot?.closing] || closingRules.question;

if (slot) {
  console.log(`🕒 投稿枠: ${slot.jst} [${slot.role}] 型=${style} 締め=${slot.closing}`);
}

// --- 本文生成（型リファレンスのルールをシステムプロンプトに埋め込む）---
const systemPrompt = `あなたはThreads運用のプロライターです。以下のルールを厳守して投稿本文を1本だけ書きます。

【表記ルール（Threads特有・厳守）】
- 句読点「。」「、」は使わない。半角スペースか改行で間を取る
- 冒頭は「数字」「これ」「最近/今日/昔」「セリフ」のいずれかから入る（【】は使わない）
- ${closing}
- 一人称は「${persona.persona?.first_person || "わたし"}」で統一する
- 数字を必ず1つ入れる
- 全体で最大5〜7行

【この投稿の役割】${slot?.role || "汎用"}${slot?.guide ? "（" + slot.guide + "）" : ""}
【使う型】${style}

【出力】本文テキストのみ。前置き・説明・引用符・ハッシュタグは付けない。`;

const userPrompt = `ジャンル: ${persona.genre}
今日のテーマ: ${topic}
ターゲット: ${JSON.stringify(persona.target || {})}
発信者の立場: ${persona.persona?.role || ""} / 得意: ${persona.persona?.strength || ""} / 実体験: ${persona.persona?.episode || ""}
避ける話題: ${(persona.ng?.topics || []).join(", ")}
使わない言葉: ${(persona.ng?.words || []).join(", ")}

この投稿の役割: ${slot?.role || "汎用"} / 狙い: ${slot?.goal || ""}
上記に沿って「${style}」で投稿本文を1本書いてください。`;

async function generateText() {
  // Claude（公式Anthropic SDK）で本文生成。Opus 4.8 は temperature 非対応なので渡さない。
  const res = await anthropic.messages.create({
    model: TEXT_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude本文生成に失敗: 空の応答 " + JSON.stringify(res));
  return text;
}

// 保険：句読点が混ざったら除去（ルール徹底）
function sanitize(text) {
  return text.replace(/[。、]/g, " ").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

// --- シンプルな引用カード（本文はキャプションが主役・カードは最小の視覚アイキャッチ）---
function escXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function wrapLine(text, perLine, maxLines) {
  const out = [];
  for (let i = 0; i < text.length && out.length < maxLines; i += perLine) {
    out.push(text.slice(i, i + perLine));
  }
  return out;
}

// 本文1行目（フック）だけを大きく置いた、余白多めのミニマルなカードを作る
async function makeCard(hook, handle) {
  const W = 1080;
  const line = hook.replace(/[「」“”"']/g, "").trim();
  const lines = wrapLine(line, 13, 3);
  const lineH = 96;
  const startY = W / 2 - ((lines.length - 1) * lineH) / 2 + 24;
  const tspans = lines
    .map((l, i) => `<tspan x="${W / 2}" y="${startY + i * lineH}">${escXml(l)}</tspan>`)
    .join("");
  const svg = `<svg width="${W}" height="${W}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${W}" fill="#F4F1EA"/>
    <rect x="90" y="150" width="72" height="10" rx="5" fill="#C7743B"/>
    <text text-anchor="middle" font-family="'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif" font-weight="bold" font-size="66" fill="#2B2B2B">${tspans}</text>
    <text x="${W - 90}" y="${W - 80}" text-anchor="end" font-family="sans-serif" font-size="34" fill="#8A8378">${escXml(handle)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// --- 実行 ---
const text = sanitize(await generateText());
console.log("📝 本文生成:\n" + text + "\n");

// 画像は「時々」だけ：slot.image が true の枠のみカードを添付。基本はテキストのみ。
const wantImage = slot?.image === true;
let imagePath = null;

if (wantImage) {
  const hook = text.split("\n")[0].replace(/[？?…]/g, "").trim();
  const handle = persona.image?.handle || "みう";
  const imgBuf = await makeCard(hook, handle);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  imagePath = `outbox/images/${stamp}.png`;
  mkdirSync(join(ROOT, "outbox", "images"), { recursive: true });
  writeFileSync(join(ROOT, imagePath), imgBuf);
  console.log(`🖼️  引用カードを作成: ${imagePath}`);

  // 古い画像を掃除（直近3枚だけ残す。投稿後は不要なため）
  const KEEP = 3;
  const imgDir = join(ROOT, "outbox", "images");
  const imgs = readdirSync(imgDir).filter((f) => f.endsWith(".png")).sort();
  const stale = imgs.slice(0, Math.max(0, imgs.length - KEEP));
  for (const f of stale) unlinkSync(join(imgDir, f));
  if (stale.length) console.log(`🧹 古い画像を${stale.length}枚削除（直近${KEEP}枚を保持）`);
} else {
  console.log("📄 この枠はテキストのみ投稿（画像なし）");
}

writeFileSync(
  join(ROOT, "outbox", "post.json"),
  JSON.stringify(
    { text, imagePath, topic, style, slot: slot?.key || null, createdAt: new Date().toISOString() },
    null,
    2
  )
);
console.log("✅ 生成完了 → 次は src/post.mjs で公開します");
