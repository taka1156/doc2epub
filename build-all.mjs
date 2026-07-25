#!/usr/bin/env node
/**
 * build-all.mjs
 * repo.json を読み込み、指定リポジトリをクローンして md2honkit で変換し、epub を生成する。
 *
 * 使い方:
 *   node build-all.mjs                        # repo.json を読む
 *   node build-all.mjs --config repo.json     # 設定ファイルを明示
 *   node build-all.mjs --dist ./dist          # epub の出力先
 *   node build-all.mjs --only vitepress-docs  # 特定の book だけビルド
 *   node build-all.mjs --skip-epub            # HonKit プロジェクト生成まで (epub化しない)
 *
 * repo.json の構造:
 *   {
 *     "defaults": { <md2honkit のオプション名>: <値> },   // 全 book 共通の既定値
 *     "books": [
 *       {
 *         "name": "出力ファイル名 (name.epub になる)",
 *         "repo": "https://github.com/owner/name.git",   // ローカルパスも可
 *         "ref":  "main",                                // ブランチ/タグ/コミット (省略可)
 *         "options": {                                    // md2honkit の CLI オプションをそのまま記述
 *           "type": "vitepress",
 *           "input": "docs",          // ← クローンしたリポジトリのルートからの相対パス
 *           "title": "本のタイトル",
 *           "author": "著者",
 *           "lang": "ja",
 *           "config": ".vitepress/config.mjs",   // 任意
 *           "sidebars": "sidebars.js"            // Docusaurus の場合、任意
 *         }
 *       }
 *     ]
 *   }
 *
 * options のキーは md2honkit.mjs の CLI フラグ名と 1:1 で対応します。
 * ここに書いたキーはそのまま `--<キー> <値>` としてコマンドに渡されるので、
 * md2honkit 側にオプションを追加すれば repo.json 側も自動的に対応します。
 * 値が true の場合はフラグのみ (`--build` のような真偽値オプション) として渡されます。
 *
 * ただし input / output / config / sidebars の各パスだけは、
 * クローン先ディレクトリを基準に解決してから渡します。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ---------- 引数パース ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const CONFIG_PATH = path.resolve(args.config || "./repo.json");
const DIST_DIR = path.resolve(args.dist || "./dist");
const WORK_DIR = path.resolve(args.work || "./.work");
const SKIP_EPUB = Boolean(args["skip-epub"]);
const ONLY = typeof args.only === "string" ? args.only.split(",").map((s) => s.trim()) : null;

// md2honkit.mjs の場所 (このスクリプトと同じディレクトリにある想定)
const MD2HONKIT = path.resolve(
  args.script || path.join(path.dirname(new URL(import.meta.url).pathname), "md2honkit.mjs")
);

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`エラー: 設定ファイルが見つかりません: ${CONFIG_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(MD2HONKIT)) {
  console.error(`エラー: md2honkit.mjs が見つかりません: ${MD2HONKIT}`);
  process.exit(1);
}

// ---------- ユーティリティ ----------
function run(cmd, cmdArgs, opts = {}) {
  console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
  return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** リポジトリを取得する。ローカルパスならコピー、URLなら shallow clone。 */
function fetchRepo(book, destDir) {
  rmrf(destDir);
  ensureDir(path.dirname(destDir));

  const isLocal = fs.existsSync(book.repo) && fs.statSync(book.repo).isDirectory();

  if (isLocal) {
    console.log(`  ローカルディレクトリをコピー: ${book.repo}`);
    fs.cpSync(path.resolve(book.repo), destDir, { recursive: true });
    return;
  }

  const cloneArgs = ["clone", "--depth", "1"];
  if (book.ref) cloneArgs.push("--branch", book.ref);
  cloneArgs.push(book.repo, destDir);

  try {
    run("git", cloneArgs);
  } catch (e) {
    // ref がコミットハッシュの場合 --branch では失敗するので、full clone + checkout でリトライ
    if (book.ref) {
      console.log("  --branch での取得に失敗。full clone してから checkout します。");
      rmrf(destDir);
      run("git", ["clone", book.repo, destDir]);
      run("git", ["-C", destDir, "checkout", book.ref]);
    } else {
      throw e;
    }
  }
}

/** options オブジェクトを md2honkit の CLI 引数配列に変換する */
function buildCliArgs(options, repoDir, honkitDir) {
  // これらはリポジトリルート基準の相対パスとして解決する
  const PATH_KEYS = new Set(["input", "config", "sidebars"]);
  const cliArgs = [];

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === false) continue;
    // output はこちらで管理するので無視する
    if (key === "output") continue;
    // epub 化は build-all 側で行うため、md2honkit の --build は無効化する
    if (key === "build") continue;

    if (value === true) {
      cliArgs.push(`--${key}`);
      continue;
    }

    const resolved = PATH_KEYS.has(key) ? path.resolve(repoDir, String(value)) : String(value);
    cliArgs.push(`--${key}`, resolved);
  }

  cliArgs.push("--output", honkitDir);
  return cliArgs;
}

// ---------- メイン ----------
function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const defaults = config.defaults || {};
  let books = config.books || [];

  if (!Array.isArray(books) || books.length === 0) {
    console.error("エラー: repo.json の books が空です。");
    process.exit(1);
  }

  if (ONLY) {
    books = books.filter((b) => ONLY.includes(b.name));
    if (books.length === 0) {
      console.error(`エラー: --only で指定された book が見つかりません: ${ONLY.join(", ")}`);
      process.exit(1);
    }
  }

  ensureDir(DIST_DIR);
  ensureDir(WORK_DIR);

  const succeeded = [];
  const failed = [];

  for (const book of books) {
    const name = book.name;
    console.log(`\n=== [${name}] ビルド開始 ===`);

    try {
      if (!name) throw new Error("book に name がありません。");
      if (!book.repo) throw new Error("book に repo がありません。");

      const repoDir = path.join(WORK_DIR, name, "repo");
      const honkitDir = path.join(WORK_DIR, name, "honkit");

      // 1. リポジトリ取得
      fetchRepo(book, repoDir);

      // 2. defaults と options をマージして CLI 引数化
      const options = { ...defaults, ...(book.options || {}) };
      if (!options.type) throw new Error("options.type (vitepress | docusaurus) が必要です。");
      if (!options.title) options.title = name;

      rmrf(honkitDir);
      const cliArgs = buildCliArgs(options, repoDir, honkitDir);

      // 3. HonKit 形式に変換
      run(process.execPath, [MD2HONKIT, ...cliArgs]);

      // 4. epub 生成
      if (SKIP_EPUB) {
        console.log("  --skip-epub が指定されたため epub 生成はスキップします。");
      } else {
        const epubPath = path.join(DIST_DIR, `${name}.epub`);
        run("npx", ["honkit", "epub", honkitDir, epubPath]);

        if (!fs.existsSync(epubPath)) {
          throw new Error("epub ファイルが生成されませんでした。");
        }
        const sizeKb = Math.round(fs.statSync(epubPath).size / 1024);
        console.log(`  生成完了: ${epubPath} (${sizeKb} KB)`);
      }

      succeeded.push(name);
      console.log(`=== [${name}] 成功 ===`);
    } catch (e) {
      console.error(`=== [${name}] 失敗: ${e.message} ===`);
      failed.push({ name, error: e.message });
    }
  }

  // ---------- ビルド結果のメタ情報を出力 ----------
  const manifest = {
    generatedAt: new Date().toISOString(),
    books: succeeded.map((name) => {
      const epubPath = path.join(DIST_DIR, `${name}.epub`);
      return {
        name,
        file: `${name}.epub`,
        size: fs.existsSync(epubPath) ? fs.statSync(epubPath).size : null,
      };
    }),
    failed,
  };
  fs.writeFileSync(
    path.join(DIST_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  console.log(`\n===== 結果 =====`);
  console.log(`成功: ${succeeded.length} 件 / 失敗: ${failed.length} 件`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  }

  // 1件でも成功していれば成果物はあるので、全滅した場合のみ異常終了とする
  if (succeeded.length === 0) {
    process.exit(1);
  }
}

main();
