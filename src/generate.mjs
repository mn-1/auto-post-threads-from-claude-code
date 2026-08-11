// 本文生成 + 画像生成（ハイブリッド：Pexels素材取得 → gpt-image-1で加工 → 文字入れ）
// 出力: outbox/post.json（本文）と outbox/images/<日付>.png（画像）
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT, loadEnv, loadPersona, requireEnv } from "./config.mjs";

loadEnv();
// 文章=Claude(必須)。画像のAI加工=OpenAI(任意・無ければ無料フォールバック)。
requireEnv(["ANTHROPIC_API_KEY"]);
const persona = loadPersona();

const OPENAI = "https://api.openai.com/v1";
const KEY = process.env.OPENAI_API_KEY; // 画像生成用
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
const style = pick(styles, 1);

// --- 本文生成（型リファレンスのルールをシステムプロンプトに埋め込む）---
const systemPrompt = `あなたはThreads運用のプロライターです。以下のルールを厳守して投稿本文を1本だけ書きます。

【表記ルール（Threads特有・厳守）】
- 句読点「。」「、」は使わない。半角スペースか改行で間を取る
- 冒頭は「数字」「これ」「最近/今日/昔」「セリフ」のいずれかから入る（【】は使わない）
- 締めは「〜な人います？」または「？」「…」で終える
- 一人称は「${persona.persona?.first_person || "わたし"}」で統一する
- 数字を必ず1つ入れる
- 全体で最大5〜7行

【使う型】${style}

【出力】本文テキストのみ。前置き・説明・引用符・ハッシュタグは付けない。`;

const userPrompt = `ジャンル: ${persona.genre}
今日のテーマ: ${topic}
ターゲット: ${JSON.stringify(persona.target || {})}
発信者の立場: ${persona.persona?.role || ""} / 得意: ${persona.persona?.strength || ""} / 実体験: ${persona.persona?.episode || ""}
避ける話題: ${(persona.ng?.topics || []).join(", ")}
使わない言葉: ${(persona.ng?.words || []).join(", ")}

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

// --- 画像：Pexelsで素材取得 → gpt-image-1で加工。素材が無ければ生成のみ ---
async function fetchStock(query) {
  if (!process.env.PEXELS_API_KEY) return null;
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`;
  const r = await fetch(url, { headers: { Authorization: process.env.PEXELS_API_KEY } });
  if (!r.ok) return null;
  const j = await r.json();
  const src = j.photos?.[0]?.src?.large;
  if (!src) return null;
  const img = await fetch(src);
  return Buffer.from(await img.arrayBuffer());
}

// キャラ「みう」の基準画像を assets/character/ から全部読む（顔の一貫性のため）
function loadCharacterRefs() {
  const dir = join(ROOT, "assets", "character");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => ({
      buf: readFileSync(join(dir, f)),
      name: f,
      type: f.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
    }));
}

async function editWithRefs(refs, prompt) {
  const form = new FormData();
  form.append("model", "gpt-image-1");
  // 1枚なら "image"、複数なら "image[]"（gpt-image-1はマルチ参照に対応）
  const field = refs.length > 1 ? "image[]" : "image";
  for (const r of refs) form.append(field, new Blob([r.buf], { type: r.type }), r.name);
  form.append("prompt", prompt);
  form.append("size", "1024x1024");
  const res = await fetch(`${OPENAI}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  const j = await res.json();
  if (!res.ok) throw new Error("画像加工(edits)に失敗: " + JSON.stringify(j));
  return j.data[0].b64_json;
}

// gpt-image-1（有料）で画像を作る。失敗しても投稿は止めない。
async function aiImage(imgPrompt, charRefs, stock) {
  let b64;
  if (charRefs.length) {
    // キャラ基準画像あり → 顔・髪型・雰囲気を固定したまま、シーンだけ差し替え
    console.log(
      `🎨 画像モード: キャラ「みう」基準${charRefs.length}枚で一貫生成` +
        (stock ? " ＋ Pexels素材を背景参考に" : "")
    );
    const refs = stock ? [...charRefs, { buf: stock, name: "scene.jpg", type: "image/jpeg" }] : charRefs;
    const prompt =
      "1枚目（複数あれば全て）の人物と同一人物にすること（顔・髪型・雰囲気を厳密に維持）。" +
      "その人物を主役に、次のシーンで自然な写真を作る: " +
      imgPrompt +
      "。人物は1人だけ 実写風 高品質 正方形。";
    b64 = await editWithRefs(refs, prompt);
  } else if (stock) {
    console.log("🎨 画像モード: Pexels素材を取得 → gpt-image-1で加工（キャラ画像は未配置）");
    b64 = await editWithRefs([{ buf: stock, name: "stock.jpg", type: "image/jpeg" }], imgPrompt);
  } else {
    console.log("🎨 画像モード: 素材もキャラ画像も無し → gpt-image-1の生成のみ");
    const r = await fetch(`${OPENAI}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt: imgPrompt, size: "1024x1024", n: 1 }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error("画像生成に失敗: " + JSON.stringify(j));
    b64 = j.data[0].b64_json;
  }
  return Buffer.from(b64, "base64");
}

async function makeImage(imgPrompt, stockQuery) {
  const charRefs = loadCharacterRefs();
  const stock = await fetchStock(stockQuery);

  // OpenAIキーがあれば gpt-image-1 を試す。失敗しても無料フォールバックに切替。
  if (KEY) {
    try {
      return await aiImage(imgPrompt, charRefs, stock);
    } catch (e) {
      console.warn("⚠️ gpt-image-1 が使えません（残高不足など）→ 無料フォールバックに切替: " + e.message);
    }
  } else {
    console.log("🎨 画像モード: OpenAIキー未設定 → 無料フォールバックで画像を用意");
  }

  // --- 無料フォールバック（OpenAI不要）: Pexels素材 → みう画像 → 無地カード ---
  if (stock) {
    console.log("🖼️ フォールバック: Pexels素材をそのまま使用（後で文字入れ）");
    return stock;
  }
  if (charRefs.length) {
    console.log("🖼️ フォールバック: みう基準画像を使用");
    return charRefs[0].buf;
  }
  console.log("🖼️ フォールバック: 無地カードを生成");
  return sharp({
    create: { width: 1080, height: 1080, channels: 3, background: { r: 244, g: 241, b: 234 } },
  })
    .png()
    .toBuffer();
}

// SVG用のエスケープと簡易折り返し
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function wrap(text, perLine) {
  const out = [];
  for (let i = 0; i < text.length; i += perLine) out.push(text.slice(i, i + perLine));
  return out.slice(0, 3);
}

// 画像に本文の要点を文字入れ（overlay_text: true のとき）
async function overlayText(buf, headline) {
  const W = 1080;
  const lines = wrap(headline, 14);
  const fontSize = 60;
  const lineH = 78;
  const bandH = lines.length * lineH + 60;
  const tspans = lines
    .map(
      (l, i) =>
        `<tspan x="${W / 2}" y="${W - bandH + 70 + i * lineH}">${esc(l)}</tspan>`
    )
    .join("");
  const svg = `<svg width="${W}" height="${W}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${W - bandH}" width="${W}" height="${bandH}" fill="rgba(0,0,0,0.55)"/>
    <text text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${fontSize}" fill="#ffffff">${tspans}</text>
  </svg>`;
  return sharp(buf)
    .resize(W, W, { fit: "cover" })
    .composite([{ input: Buffer.from(svg), gravity: "southwest" }])
    .png()
    .toBuffer();
}

// --- 実行 ---
const text = sanitize(await generateText());
console.log("📝 本文生成:\n" + text + "\n");

const imgStyle = persona.image?.style || "明るくミニマルな写真";
const imgPrompt = `${imgStyle}. テーマ: ${topic}. 文字やロゴは入れない クリーンな構図 Threads向け正方形`;
const stockQuery = persona.image?.keywords_hint || `${persona.genre} ${topic}`;

let imgBuf = await makeImage(imgPrompt, stockQuery);
if (persona.image?.overlay_text) {
  const headline = text.split("\n")[0].replace(/[？?…]/g, "").trim();
  imgBuf = await overlayText(imgBuf, headline);
} else {
  imgBuf = await sharp(imgBuf).resize(1080, 1080, { fit: "cover" }).png().toBuffer();
}

// --- 保存 ---
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const imgRel = `outbox/images/${stamp}.png`;
mkdirSync(join(ROOT, "outbox", "images"), { recursive: true });
writeFileSync(join(ROOT, imgRel), imgBuf);
writeFileSync(
  join(ROOT, "outbox", "post.json"),
  JSON.stringify({ text, imagePath: imgRel, topic, style, createdAt: stamp }, null, 2)
);
console.log(`🖼️  画像を保存: ${imgRel}`);
console.log("✅ 生成完了 → 次は src/post.mjs で公開します");
