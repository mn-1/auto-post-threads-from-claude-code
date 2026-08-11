// persona.yml と .env を読み込む共通モジュール
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");

// --- .env を読む（GitHub Actions では Secrets が環境変数に入るので .env は無くてもOK）---
export function loadEnv() {
  const path = join(ROOT, ".env");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.includes("=") || line.trim().startsWith("#")) continue;
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  }
  return process.env;
}

// --- persona.yml を読む ---
export function loadPersona() {
  const path = join(ROOT, "persona.yml");
  if (!existsSync(path)) {
    throw new Error("persona.yml が見つかりません。発信方針を設定してください。");
  }
  const cfg = yaml.load(readFileSync(path, "utf8"));

  // 未編集（テンプレのまま）のチェック
  if (!cfg?.genre || String(cfg.genre).includes("<")) {
    throw new Error(
      "persona.yml の genre が未設定です。< > の中を自分の内容に書き換えてください。"
    );
  }
  return cfg;
}

// 必須の環境変数がそろっているか確認（無ければ分かりやすく落とす）
export function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `必要な環境変数が未設定です: ${missing.join(", ")}\n` +
        "ローカルは .env に、GitHub Actions は Secrets に登録してください。"
    );
  }
}
