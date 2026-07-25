#!/usr/bin/env node
/**
 * md2honkit.mjs
 * VitePress / Docusaurus の Markdown ドキュメントを HonKit 形式に変換するスクリプト。
 *
 * 使い方:
 *   node md2honkit.mjs --type vitepress   --input ./docs --output ./honkit-book --title "My Book"
 *   node md2honkit.mjs --type docusaurus  --input ./docs --output ./honkit-book --title "My Book" \
 *        --sidebars ./sidebars.js
 *
 * オプション:
 *   --type       vitepress | docusaurus (必須)
 *   --input      Markdown が置かれているディレクトリ (デフォルト: ./docs)
 *   --output     HonKit プロジェクトの出力先 (デフォルト: ./honkit-book)
 *   --title      本のタイトル (デフォルト: "Untitled Book")
 *   --author     著者名
 *   --config     VitePress の config.mjs / config.ts のパス (省略時は input/.vitepress/config.mjs を推測)
 *   --sidebars   Docusaurus の sidebars.js のパス (省略時は input/../sidebars.js を推測)
 *   --lang       言語コード (デフォルト: ja)
 *   --build      生成後に `npx honkit epub` を自動実行する (要 honkit + calibre の ebook-convert)
 *
 * 必要な依存関係:
 *   npm install gray-matter fast-glob
 *
 * epub化には別途 HonKit と Calibre が必要です:
 *   npm install -g honkit
 *   # Calibre をインストールし ebook-convert コマンドが PATH にあること
 *   npx honkit epub ./honkit-book ./honkit-book/book.epub
 *
 * 制限事項 (自動変換の限界):
 *   - VitePress の Vue コンポーネント / <script setup> は実行できないため中身は削除されます。
 *   - ::: tip / ::: warning などのカスタムコンテナは簡易的に見出し付き引用に変換します。
 *   - Docusaurus の import 文や JSX コンポーネントタグは剥がしてテキストだけ残します
 *     (コンポーネントが生成する表やタブの中身は失われる場合があります)。
 *   - 変換後は必ず目視で確認してください。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import matter from "gray-matter";
import fg from "fast-glob";

const require = createRequire(import.meta.url);

// ---------- 引数パース ----------
function parseArgs(argv) {
  const args = { lang: "ja", title: "Untitled Book", output: "./honkit-book", input: "./docs" };
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

if (!args.type || !["vitepress", "docusaurus"].includes(args.type)) {
  console.error("エラー: --type vitepress または --type docusaurus を指定してください。");
  process.exit(1);
}

const INPUT_DIR = path.resolve(args.input);
const OUTPUT_DIR = path.resolve(args.output);
const TITLE = args.title;
const AUTHOR = args.author || "";
const LANG = args.lang;

// Calibre の分割上限 (約260KB) 対策。Markdown は HTML で 5〜6 倍に膨らむため
// 既定を 30KB (EPUB換算で約180KB) とし、0 を指定すると分割を無効化する。
const MAX_PAGE_BYTES =
  args["max-page-bytes"] === undefined ? 30000 : Number(args["max-page-bytes"]);
let splitPageCount = 0;

if (!fs.existsSync(INPUT_DIR)) {
  console.error(`エラー: 入力ディレクトリが見つかりません: ${INPUT_DIR}`);
  process.exit(1);
}

// ---------- サイドバー(目次)の取得 ----------

/**
 * 正規化後の共通フォーマット:
 * [
 *   { title: "はじめに", file: "guide/intro.md" },
 *   { title: "グループA", children: [ {title, file}, ... ] },
 *   ...
 * ]
 */
async function loadVitepressSidebar() {
  const configPath = args.config
    ? path.resolve(args.config)
    : path.join(INPUT_DIR, ".vitepress", "config.mjs");

  if (!fs.existsSync(configPath)) {
    console.warn(`[警告] VitePress設定が見つかりません (${configPath})。自動走査モードにフォールバックします。`);
    return null;
  }

  try {
    const mod = await import("file://" + configPath);
    const config = mod.default ?? mod;
    const sidebar = config?.themeConfig?.sidebar;
    if (!sidebar) {
      console.warn("[警告] themeConfig.sidebar が見つかりません。自動走査モードにフォールバックします。");
      return null;
    }

    // sidebar は配列 か { "/path/": [...] } の形式がある
    const rawItems = Array.isArray(sidebar) ? sidebar : Object.values(sidebar).flat();

    function normalize(items) {
      return items.map((item) => {
        if (item.items) {
          return { title: item.text || item.title, children: normalize(item.items) };
        }
        let link = item.link || item.path || "";
        link = link.replace(/^\//, "").replace(/\/$/, "/index");
        const file = link.endsWith(".md") ? link : `${link}.md`;
        return { title: item.text || item.title || file, file };
      });
    }

    return normalize(rawItems);
  } catch (e) {
    console.warn(`[警告] VitePress設定の読み込みに失敗しました: ${e.message}`);
    return null;
  }
}

function loadDocusaurusSidebar() {
  const sidebarsPath = args.sidebars
    ? path.resolve(args.sidebars)
    : path.join(INPUT_DIR, "..", "sidebars.js");

  if (!fs.existsSync(sidebarsPath)) {
    console.warn(`[警告] Docusaurus sidebars.js が見つかりません (${sidebarsPath})。自動走査モードにフォールバックします。`);
    return null;
  }

  try {
    const mod = require(sidebarsPath);
    const sidebars = mod.default ?? mod;
    const allSidebars = Object.values(sidebars).flat();

    function resolveDocIdToFile(id) {
      // Docusaurus の doc id は拡張子なしの相対パス
      const candidates = [`${id}.md`, `${id}.mdx`, `${id}/index.md`, `${id}/index.mdx`];
      for (const c of candidates) {
        if (fs.existsSync(path.join(INPUT_DIR, c))) return c;
      }
      return `${id}.md`; // 見つからなくても一応返す
    }

    function normalize(items) {
      return items.map((item) => {
        if (typeof item === "string") {
          // ラベル無しの ID 指定。実ファイルから本来のタイトルを読む
          const file = resolveDocIdToFile(item);
          return { title: titleFromFile(file), file };
        }
        if (item.type === "category") {
          return { title: item.label, children: normalize(item.items) };
        }
        if (item.type === "doc") {
          const docFile = resolveDocIdToFile(item.id);
          return { title: item.label || titleFromFile(docFile), file: docFile };
        }
        return { title: item.label || JSON.stringify(item), file: "" };
      });
    }

    return normalize(allSidebars);
  } catch (e) {
    console.warn(`[警告] sidebars.js の読み込みに失敗しました: ${e.message}`);
    return null;
  }
}

/** 設定ファイルが無い/読めない場合のフォールバック: ディレクトリを再帰的に走査 */
async function autoDiscover() {
  const files = await fg(["**/*.md", "**/*.mdx"], {
    cwd: INPUT_DIR,
    ignore: ["**/node_modules/**", "**/.vitepress/**", "**/.docusaurus/**"],
  });
  files.sort();

  // ディレクトリごとにグルーピング
  const tree = {};
  for (const f of files) {
    const dir = path.dirname(f);
    tree[dir] = tree[dir] || [];
    tree[dir].push(f);
  }

  const result = [];
  for (const [dir, group] of Object.entries(tree)) {
    const entries = group.map((f) => ({ title: titleFromFile(f), file: f }));
    if (dir === ".") {
      result.push(...entries);
    } else {
      result.push({ title: dir, children: entries });
    }
  }
  return result;
}

// ---------- 画像などのアセット処理 ----------
// honkit epub は参照先の実ファイルを開くため、コピーしないと ENOENT でビルドが落ちる
// (honkit build は無視するので、build では通るのに epub で落ちる)。

const copiedAssets = new Map(); // 元パス -> 出力先の絶対パス
let missingAssetCount = 0;

/** 参照文字列から実在するソースファイルの絶対パスを求める */
function resolveAssetSource(ref, srcDir) {
  let p = String(ref).trim().replace(/^<|>$/g, "").split(/[?#]/)[0];
  if (!p) return null;
  if (/^(https?:|data:|mailto:|tel:|#)/i.test(p)) return null; // 外部・埋め込みは対象外

  try {
    p = decodeURIComponent(p);
  } catch {
    /* デコードできない場合はそのまま扱う */
  }

  if (p.startsWith("/")) {
    // ルート絶対参照: VitePress は public/, Docusaurus は static/ に置かれる
    const candidates = [
      path.join(INPUT_DIR, "public", p),
      path.join(INPUT_DIR, "..", "static", p),
      path.join(INPUT_DIR, "..", "public", p),
      path.join(INPUT_DIR, p),
    ];
    return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
  }

  const abs = path.resolve(srcDir, p);
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

/** アセットを出力先へコピーし、ページから見た相対パスを返す */
function copyAsset(absSrc, destDir) {
  let destAbs = copiedAssets.get(absSrc);

  if (!destAbs) {
    const rel = path.relative(INPUT_DIR, absSrc);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      // 入力ディレクトリ配下ならそのままの構造で複製する
      destAbs = path.join(OUTPUT_DIR, rel);
    } else {
      // public/ や static/ など外側にあるものは _assets/ に集約する
      let base = path.basename(absSrc);
      destAbs = path.join(OUTPUT_DIR, "_assets", base);
      let n = 1;
      while (
        fs.existsSync(destAbs) &&
        [...copiedAssets.values()].includes(destAbs) === false
      ) {
        const ext = path.extname(base);
        destAbs = path.join(OUTPUT_DIR, "_assets", `${path.basename(base, ext)}-${n++}${ext}`);
      }
    }

    ensureDir(path.dirname(destAbs));
    fs.copyFileSync(absSrc, destAbs);
    copiedAssets.set(absSrc, destAbs);
  }

  return path.relative(destDir, destAbs).split(path.sep).join("/");
}

/**
 * 本文中の画像参照を解決する。
 * - 実在するもの: 出力先へコピーし、必要ならリンクを貼り替える
 * - 実在しないもの: 参照を除去する (残すと epub 生成が ENOENT で失敗するため)
 */
function processAssets(text, relFile) {
  if (!relFile) return text;

  const srcDir = path.dirname(path.join(INPUT_DIR, relFile));
  const destDir = path.dirname(path.join(OUTPUT_DIR, toMdPath(relFile)));

  const handle = (ref) => {
    const abs = resolveAssetSource(ref, srcDir);
    if (!abs) return null;
    return copyAsset(abs, destDir);
  };

  // Markdown 画像記法: ![alt](path "title")
  text = text.replace(
    /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)((?:\s+["'][^"']*["'])?)\s*\)/g,
    (whole, alt, ref, title) => {
      if (/^(https?:|data:)/i.test(String(ref).replace(/^</, ""))) return whole;
      const newRef = handle(ref);
      if (newRef) return `![${alt}](${newRef}${title})`;
      missingAssetCount++;
      return alt ? `*${alt}*` : ""; // 見つからない画像は代替テキストに置き換える
    }
  );

  // リンク先がページではなくファイル (svg/png/pdf/zip など) の場合も実体が必要になる。
  // 例: [![](/x.svg)](/x.svg) の外側リンク。未処理だと honkit epub が ENOENT で落ちる。
  const PAGE_EXT = /\.(md|mdx|html?)$/i;
  text = text.replace(
    /(^|[^!])\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]+>|[^)\s]+)((?:\s+["'][^"']*["'])?)\s*\)/g,
    (whole, lead, label, ref, title) => {
      const target = String(ref).replace(/^<|>$/g, "");
      if (/^(https?:|data:|mailto:|tel:|#)/i.test(target)) return whole;

      const bare = target.split(/[?#]/)[0];
      // 拡張子が無いもの・ページへのリンクは対象外 (通常の内部リンク)
      if (!/\.[A-Za-z0-9]{1,6}$/.test(bare) || PAGE_EXT.test(bare)) return whole;

      const newRef = handle(ref);
      if (newRef) return `${lead}[${label}](${newRef}${title})`;

      // 実体が無いファイルへのリンクは、リンクを外してラベルだけ残す
      missingAssetCount++;
      return `${lead}${label}`;
    }
  );

  // 参照定義リンク: [label]: /img/js.svg "title"
  // 本文から ![][label] の形で参照される。これも実体が必要。
  text = text.replace(
    /^([ \t]{0,3}\[[^\]]+\]:[ \t]*)(\S+)([ \t]+["'(].*)?$/gm,
    (whole, head, ref, title) => {
      const target = String(ref).replace(/^<|>$/g, "");
      if (/^(https?:|data:|mailto:|tel:|#)/i.test(target)) return whole;

      const bare = target.split(/[?#]/)[0];
      if (!/\.[A-Za-z0-9]{1,6}$/.test(bare) || PAGE_EXT.test(bare)) return whole;

      const newRef = handle(ref);
      if (newRef) return `${head}${newRef}${title || ""}`;

      missingAssetCount++;
      return ""; // 実体が無い定義は削除する
    }
  );

  // HTML の <img src="...">
  text = text.replace(/<img\b[^>]*?>/gi, (tag) => {
    const m = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!m) return tag;
    if (/^(https?:|data:)/i.test(m[1])) return tag;
    const newRef = handle(m[1]);
    if (newRef) return tag.replace(m[1], newRef);
    missingAssetCount++;
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
    return alt && alt[1] ? `*${alt[1]}*` : "";
  });

  return text;
}

// ---------- VitePress / Docusaurus のカスタムコンテナ ----------
// ::: tip / ::: success / ::: details など任意の名前のコンテナに対応する。
// HonKit には対応する装飾が無いため、見出し付きの引用ブロックに変換する。

const CONTAINER_LABELS = {
  tip: "TIP",
  note: "NOTE",
  info: "INFO",
  important: "IMPORTANT",
  warning: "WARNING",
  caution: "CAUTION",
  danger: "DANGER",
  success: "SUCCESS",
  error: "ERROR",
  details: "DETAILS",
  example: "EXAMPLE",
  quote: "QUOTE",
};

// 中身をそのまま残すだけでよいコンテナ (装飾用・表示制御用)
const PASSTHROUGH_CONTAINERS = new Set([
  "raw",
  "v-pre",
  "code-group",
  "code-group-item",
]);

/** 空行を除いた最小インデントぶんだけ字下げを解除する */
function dedent(lines) {
  const widths = lines
    .filter((l) => l.trim() !== "")
    .map((l) => l.match(/^[ \t]*/)[0].length);
  if (widths.length === 0) return lines;
  const min = Math.min(...widths);
  return min > 0 ? lines.map((l) => l.slice(min)) : lines;
}

function renderContainer(type, title, innerLines) {
  const key = type.toLowerCase();
  const body = dedent(innerLines);

  if (PASSTHROUGH_CONTAINERS.has(key)) {
    return [...body, ""];
  }

  const label = title.trim() || CONTAINER_LABELS[key] || type.toUpperCase();
  const quoted = body.map((l) => (l.trim() === "" ? ">" : `> ${l}`));

  // 末尾の空引用行を落としてから閉じる
  while (quoted.length > 0 && quoted[quoted.length - 1] === ">") quoted.pop();

  return [`> **${label}**`, ">", ...quoted, ""];
}

function transformContainers(text) {
  const lines = text.split("\n");
  let i = 0;

  // 開始行: ::: 名前 [タイトル]   / 終了行: ::: のみ
  const OPEN_RE = /^[ \t]*(:{3,})[ \t]*([A-Za-z0-9_-]+)[ \t]*(.*)$/;
  const CLOSE_RE = /^[ \t]*:{3,}[ \t]*$/;

  function parseBlock(depth) {
    const out = [];

    while (i < lines.length) {
      const line = lines[i];

      if (CLOSE_RE.test(line)) {
        // 入れ子の内側なら呼び出し元に閉じを通知する
        if (depth > 0) return out;
        // 対応する開始が無い閉じ記号は捨てる
        i++;
        continue;
      }

      const open = line.match(OPEN_RE);
      if (open) {
        const [, , type, title] = open;
        i++;
        const inner = parseBlock(depth + 1);
        if (i < lines.length && CLOSE_RE.test(lines[i])) i++; // 閉じを消費
        out.push(...renderContainer(type, title, inner));
        continue;
      }

      out.push(line);
      i++;
    }

    return out;
  }

  return parseBlock(0).join("\n");
}

// ---------- コードフェンスの言語ID正規化 ----------
// HonKit が内部で使う highlight.js には vue / svelte などの定義がなく、
// 未知の言語IDを渡すと "Unknown language" でビルドが停止する。
// 対応表で近い言語に寄せ、それでも未知のものは言語指定を外してプレーン表示にする。

const LANG_ALIASES = {
  vue: "html",
  "vue-html": "html",
  "vue-js": "javascript",
  svelte: "html",
  astro: "html",
  jsx: "javascript",
  tsx: "typescript",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mdx: "markdown",
  md: "markdown",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellsession: "bash",
  terminal: "bash",
  cmd: "dos",
  powershell: "powershell",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
  vimscript: "vim",
  docker: "dockerfile",
  gql: "graphql",
  text: "",
  txt: "",
  plaintext: "",
  ansi: "",
};

// highlight.js (HonKit 同梱版) が確実に解釈できる言語
const SUPPORTED_LANGS = new Set([
  "bash", "c", "cpp", "cs", "css", "diff", "dockerfile", "dos", "elixir", "erlang",
  "go", "graphql", "groovy", "haskell", "html", "http", "ini", "java", "javascript",
  "json", "kotlin", "less", "lua", "makefile", "markdown", "nginx", "objectivec",
  "perl", "php", "powershell", "properties", "protobuf", "python", "r", "ruby",
  "rust", "scala", "scss", "sql", "swift", "toml", "typescript", "vim", "xml",
  "yaml",
]);

function normalizeCodeFences(text) {
  const lines = text.split("\n");
  let fence = null; // 開いているフェンスの情報

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([ \t>]*)(`{3,}|~{3,})(.*)$/);
    if (!m) continue;

    const [, indent, marker, rest] = m;

    // フェンスが開いている場合、同種・同長以上のマーカーのみ閉じフェンスとみなす
    if (fence) {
      if (marker[0] === fence.char && marker.length >= fence.len && rest.trim() === "") {
        fence = null;
      }
      continue;
    }

    // 開きフェンス。info string の先頭トークンが言語ID
    const info = rest.trim();
    fence = { char: marker[0], len: marker.length };
    if (!info) continue;

    // VitePress の行ハイライト記法 (js{1,3} や ts:line-numbers) を分離する
    const rawLang = info.split(/[\s{:,]/)[0].toLowerCase();
    if (!rawLang) continue;

    const mapped = LANG_ALIASES[rawLang] ?? rawLang;
    const finalLang = SUPPORTED_LANGS.has(mapped) ? mapped : "";

    lines[i] = `${indent}${marker}${finalLang}`;
  }

  return lines.join("\n");
}

// 見出しの末尾に付く明示アンカー ({#custom-id}) を取り除く
function stripHeadingAnchor(s) {
  return String(s).replace(/\s*\{#[^}]*\}\s*$/, "").trim();
}

/** frontmatter の title、無ければ最初の H1 からページタイトルを得る */
function titleFromFile(relFile) {
  const abs = path.join(INPUT_DIR, relFile);
  if (!fs.existsSync(abs)) return path.basename(relFile).replace(/\.mdx?$/, "");
  try {
    const { data, content } = matter(fs.readFileSync(abs, "utf-8"));
    if (data.title) return stripHeadingAnchor(data.title);
    if (data.sidebar_label) return stripHeadingAnchor(data.sidebar_label);
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) return stripHeadingAnchor(h1[1]);
  } catch {
    /* 読めない場合はファイル名にフォールバック */
  }
  return path.basename(relFile).replace(/\.mdx?$/, "");
}

// ---------- Markdown 変換 (VitePress/Docusaurus 独自記法を除去) ----------
function convertMarkdown(raw, relFile) {
  const { content } = matter(raw);
  let text = content;

  // コードブロック内は加工対象外。先に退避しておかないと、
  // ```vue のサンプル内にある <script setup> や {{ }} まで壊してしまう。
  const stash = [];
  const stashBlock = (block) => {
    stash.push(block);
    return `\u0000CODEBLOCK${stash.length - 1}\u0000`;
  };

  // フェンス付きコードブロック
  text = text.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\2[^\n]*$/gm, stashBlock);
  // インラインコード
  text = text.replace(/(`+)(?:(?!\1)[\s\S])+?\1/g, stashBlock);

  // Vue の <script setup> ブロックを削除
  text = text.replace(/<script\s+setup[^>]*>[\s\S]*?<\/script>/g, "");

  // Docusaurus の import 文を削除 (先頭付近の import ... from '...';)
  text = text.replace(/^import\s+.+from\s+['"].+['"];?\s*$/gm, "");

  // 見出し末尾の明示アンカー ({#custom-id}) を除去する
  text = text.replace(/^(#{1,6}\s+.*?)\s*\{#[^}]*\}\s*$/gm, "$1");

  // ::: tip / ::: success など任意のカスタムコンテナを引用ブロックに変換
  text = transformContainers(text);

  // 画像を出力先へコピーする (コードブロックは退避中なのでサンプル内の記法は書き換わらない)
  text = processAssets(text, relFile);

  // JSXライクな独自コンポーネントタグ (先頭大文字のタグ) を除去し中身だけ残す
  text = text.replace(/<\/?[A-Z][A-Za-z0-9]*[^>]*>/g, "");

  // {{ mustache }} 変数展開はそのまま残せないため注記に変換
  text = text.replace(/\{\{\s*[^}]+\s*\}\}/g, "`[動的な値: 変換元を確認してください]`");

  // 退避したコードブロックを元に戻す。
  // 引用ブロック内 (コンテナ由来) にある場合は、行頭の "> " を全行に引き継がないと
  // 2行目以降が引用の外に出てしまう。
  text = text.replace(
    /^([ \t>]*)\u0000CODEBLOCK(\d+)\u0000/gm,
    (_, prefix, idx) => {
      const block = stash[Number(idx)];
      if (!prefix) return block;
      return block
        .split("\n")
        .map((l) => (l === "" ? prefix.trimEnd() : prefix + l))
        .join("\n");
    }
  );
  // 行頭以外に現れた残りを復元
  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => stash[Number(i)]);

  // highlight.js が解釈できない言語IDを正規化する
  text = normalizeCodeFences(text);

  return text.trim() + "\n";
}

// ---------- 巨大ページの分割 ----------
// Calibre の EPUB 変換は 1 ファイルが約 260KB を超えると分割を試み、
// 適切な分割点が無いと SplitError で停止する。
// コードハイライトで HTML は Markdown の 5〜6 倍に膨らむため、
// Markdown 段階で上限を設けて H2 見出しごとに分割しておく。

function splitLargePage(text, maxBytes) {
  if (!maxBytes || Buffer.byteLength(text, "utf-8") <= maxBytes) return null;

  const lines = text.split("\n");
  const sections = [];
  let cur = { title: null, lines: [] };
  let fence = null;

  for (const line of lines) {
    const fm = line.match(/^([ \t>]*)(`{3,}|~{3,})/);
    if (fm) {
      const ch = fm[2][0];
      const len = fm[2].length;
      if (!fence) fence = { ch, len };
      else if (ch === fence.ch && len >= fence.len) fence = null;
      cur.lines.push(line);
      continue;
    }

    // コードブロックの外にある H2 のみを分割点とする
    if (!fence) {
      const h = line.match(/^##\s+(.+?)\s*$/);
      if (h) {
        sections.push(cur);
        cur = { title: stripHeadingAnchor(h[1]), lines: [line] };
        continue;
      }
    }
    cur.lines.push(line);
  }
  sections.push(cur);

  // 見出しが少なすぎる場合は分割しても効果がない
  if (sections.filter((s) => s.title).length < 2) return null;

  // 上限に収まるよう見出し単位でまとめ直す
  const chunks = [];
  for (const s of sections) {
    const size = Buffer.byteLength(s.lines.join("\n"), "utf-8");
    const last = chunks[chunks.length - 1];
    if (!last || (last.size + size > maxBytes && last.lines.length > 0)) {
      chunks.push({ title: s.title, lines: [...s.lines], size });
    } else {
      last.lines.push(...s.lines);
      last.size += size;
    }
  }

  return chunks.length > 1 ? chunks : null;
}

// ---------- HonKit プロジェクトの書き出し ----------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// HonKit は .md しか解釈できず、.mdx を渡すと FileNotParsableError で停止する。
// 出力側の拡張子は常に .md に揃える。
function toMdPath(relFile) {
  return String(relFile).replace(/\.mdx$/i, ".md");
}

// 本文中の相対リンク (foo.mdx / foo.mdx#anchor) も .md に追従させる
function rewriteInternalLinks(text) {
  return text.replace(
    /(\]\(\s*)([^)\s]+?)\.mdx(#[^)\s]*)?(\s*\))/gi,
    (_, open, base, hash, close) => `${open}${base}.md${hash || ""}${close}`
  );
}

// HonKit は Markdown を Nunjucks テンプレートとして先に処理するため、
// 本文中の {{ ... }} や {% ... %} が構文エラーになる (JSX や Vue のサンプルで頻発)。
// ページ全体を {% raw %} で囲んでテンプレート展開の対象から外す。
// 副作用として HonKit のテンプレート機能 ({% include %} 等) は使えなくなる。
function escapeTemplating(text) {
  const cleaned = text.replace(/\{%-?\s*(?:end)?raw\s*-?%\}/g, "");
  return `{% raw %}\n${cleaned}\n{% endraw %}\n`;
}

const writtenPages = new Set(); // 二重書き込み防止 (README の特別扱いと衝突するため)

/**
 * ページを変換して書き出す。
 * 上限を超える場合は H2 見出しで分割する。
 * @returns {Array<{file: string, title: string|null}>} 出力したページ (先頭が本体)
 */
function writeConvertedFile(relFile) {
  if (!relFile) return [];
  const srcPath = path.join(INPUT_DIR, relFile);
  if (!fs.existsSync(srcPath)) {
    console.warn(`[警告] ファイルが見つかりません、スキップします: ${relFile}`);
    return [];
  }

  const raw = fs.readFileSync(srcPath, "utf-8");
  const body = rewriteInternalLinks(convertMarkdown(raw, relFile));
  const mainRel = toMdPath(relFile);

  const chunks = splitLargePage(body, MAX_PAGE_BYTES);

  const write = (rel, content) => {
    const destPath = path.join(OUTPUT_DIR, rel);
    ensureDir(path.dirname(destPath));
    fs.writeFileSync(destPath, escapeTemplating(content), "utf-8");
    writtenPages.add(rel);
  };

  if (!chunks) {
    write(mainRel, body);
    return [{ file: mainRel, title: null }];
  }

  const dir = path.dirname(mainRel);
  const base = path.basename(mainRel, ".md");
  const pages = [];

  chunks.forEach((chunk, i) => {
    const rel =
      i === 0
        ? mainRel
        : path.join(dir === "." ? "" : dir, `${base}-${i + 1}.md`).split(path.sep).join("/");
    write(rel, chunk.lines.join("\n").trim() + "\n");
    pages.push({ file: rel, title: i === 0 ? null : chunk.title || `${base} (${i + 1})` });
  });

  splitPageCount++;
  return pages;
}

function buildSummary(tree, depth = 0) {
  let out = "";
  const indent = "  ".repeat(depth);
  for (const node of tree) {
    if (node.children) {
      out += `${indent}* ${node.title}\n`;
      out += buildSummary(node.children, depth + 1);
    } else {
      const pages = writeConvertedFile(node.file);
      if (pages.length === 0) continue;
      out += `${indent}* [${node.title}](${pages[0].file})\n`;
      for (const p of pages.slice(1)) {
        out += `${indent}  * [${p.title}](${p.file})\n`;
      }
    }
  }
  return out;
}

async function main() {
  console.log(`[情報] type=${args.type} input=${INPUT_DIR} output=${OUTPUT_DIR}`);

  let tree =
    args.type === "vitepress" ? await loadVitepressSidebar() : loadDocusaurusSidebar();

  if (!tree) {
    console.log("[情報] 自動走査モードで目次を生成します。");
    tree = await autoDiscover();
  }

  ensureDir(OUTPUT_DIR);

  const summaryBody = buildSummary(tree);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "SUMMARY.md"),
    `# Summary\n\n${summaryBody}`,
    "utf-8"
  );

  // README.md (表紙代わり)
  const readmeSrc = [
    "README.md", "README.mdx",
    "index.md", "index.mdx",
    "intro.md", "intro.mdx",
    "introduction.md", "introduction.mdx",
  ]
    .map((f) => path.join(INPUT_DIR, f))
    .find((p) => fs.existsSync(p));
  if (readmeSrc && !writtenPages.has("README.md")) {
    const readmeRel = path.relative(INPUT_DIR, readmeSrc);
    fs.writeFileSync(
      path.join(OUTPUT_DIR, "README.md"),
      escapeTemplating(
        rewriteInternalLinks(
          convertMarkdown(fs.readFileSync(readmeSrc, "utf-8"), readmeRel)
        )
      ),
      "utf-8"
    );
  } else if (!readmeSrc && !writtenPages.has("README.md")) {
    fs.writeFileSync(path.join(OUTPUT_DIR, "README.md"), `# ${TITLE}\n`, "utf-8");
  }

  // book.json
  const bookJson = {
    title: TITLE,
    author: AUTHOR,
    language: LANG,
    plugins: [],
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "book.json"),
    JSON.stringify(bookJson, null, 2),
    "utf-8"
  );

  console.log(`[完了] HonKitプロジェクトを ${OUTPUT_DIR} に生成しました。`);
  console.log(`[情報] アセットを ${copiedAssets.size} 件コピーしました。`);
  if (splitPageCount > 0) {
    console.log(
      `[情報] 上限(${MAX_PAGE_BYTES}バイト)を超えるページ ${splitPageCount} 件を見出し単位で分割しました。`
    );
  }
  if (missingAssetCount > 0) {
    console.warn(
      `[警告] 参照先が見つからない画像 ${missingAssetCount} 件を代替テキストに置き換えました。`
    );
  }
  console.log("次のコマンドで epub を生成できます:");
  console.log(`  npx honkit epub ${OUTPUT_DIR} ${path.join(OUTPUT_DIR, "book.epub")}`);

  if (args.build) {
    const { execSync } = await import("node:child_process");
    try {
      console.log("[情報] honkit epub を実行します...");
      execSync(`npx honkit epub "${OUTPUT_DIR}" "${path.join(OUTPUT_DIR, "book.epub")}"`, {
        stdio: "inherit",
      });
    } catch (e) {
      console.error("[エラー] epub生成に失敗しました。honkitとCalibre(ebook-convert)がインストールされているか確認してください。");
    }
  }
}

main();
